"use strict";

/**
 * EME (Encrypted Media Extensions) Interception Module
 *
 * Intercepts the Encrypted Media Extensions API to capture:
 * - PSSH init data from MediaKeySystemAccess
 * - License challenge from MediaKeySession.generateRequest()
 * - License response from MediaKeySession.message events
 *
 * This enables the CDM-proxy pipeline to extract decryption keys
 * from DRM-protected streams (Widevine, PlayReady).
 *
 * Architecture:
 *   Content Script → Background → Native Host → Go Binary
 *
 * The captured data is sent to the background script via runtime
 * messaging, which forwards it to the native host for CDM key
 * extraction and segment decryption.
 */

/** @type {object} */
const extensionApi = (typeof browser !== "undefined" ? browser :
                     typeof chrome !== "undefined" ? chrome :
                     { runtime: { sendMessage() {} } });

// ─── State ─────────────────────────────────────────────────────────────────

/** @type {Array<{initDataType: string, initData: string, keySystem: string, sessionId?: string, licenseRequest?: string, licenseResponse?: string, capturedAt: number}>} */
const capturedSessions = [];

/** @type {Map<string, {sessionId: string, initDataType: string, initData: string, keySystem: string}>} */
const activeSessions = new Map();

let originalRequestMediaKeySystemAccess = null;
let isActive = false;

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  /** Maximum number of sessions to capture before stopping. */
  maxSessions: 20,
  /** Maximum size of init data (PSSH) in bytes to capture. */
  maxInitDataBytes: 65536,
  /** Whether to forward captured data to background immediately. */
  autoForward: true,
};

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Convert an ArrayBuffer to a base64 string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Forward captured session data to the background script.
 * @param {Object} sessionData
 */
function forwardToBackground(sessionData) {
  if (!CONFIG.autoForward) {
    return;
  }

  try {
    extensionApi.runtime.sendMessage({
      type: "emeCapturedSession",
      session: sessionData,
    }).catch(() => {
      // Extension context may be unavailable during page unload
    });
  } catch (_error) {
    // Ignore errors when extension context is destroyed
  }
}

// ─── MediaKeySession Wrapper ────────────────────────────────────────────────

/**
 * Create a proxy for a MediaKeySession that intercepts generateRequest()
 * and message events.
 *
 * @param {MediaKeySession} session - The original session object.
 * @param {string} keySystem - The key system identifier (e.g., "com.widevine.alpha").
 * @returns {MediaKeySession} The proxied session.
 */
function proxyMediaKeySession(session, keySystem) {
  const originalGenerateRequest = session.generateRequest.bind(session);
  const originalClose = session.close.bind(session);
  const sessionId = `eme_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Intercept generateRequest to capture init data
  session.generateRequest = function (initDataType, initData) {
    // Store init data for this session
    if (initData && initData.byteLength > 0 && initData.byteLength <= CONFIG.maxInitDataBytes) {
      const initDataB64 = arrayBufferToBase64(initData);

      capturedSessions.push({
        initDataType: String(initDataType),
        initData: initDataB64,
        keySystem,
        sessionId,
        capturedAt: Date.now(),
      });

      activeSessions.set(sessionId, {
        sessionId,
        initDataType: String(initDataType),
        initData: initDataB64,
        keySystem,
      });

      forwardToBackground({
        type: "initData",
        initDataType: String(initDataType),
        initData: initDataB64,
        keySystem,
        sessionId,
      });

      // Limit number of tracked sessions
      if (capturedSessions.length > CONFIG.maxSessions) {
        capturedSessions.shift();
      }
    }

    return originalGenerateRequest(initDataType, initData);
  };

  // Intercept close to clean up
  session.close = function () {
    activeSessions.delete(sessionId);
    return originalClose();
  };

  // Intercept message events to capture license exchanges
  session.addEventListener("message", function onMessage(event) {
    const messageType = event.messageType;
    const message = event.message;

    if (!message || !message.byteLength) {
      return;
    }

    const messageB64 = arrayBufferToBase64(message);
    const activeSession = activeSessions.get(sessionId);

    if (messageType === "license-request" || messageType === "license-request-and-key") {
      // This is the license challenge — store it
      if (activeSession) {
        activeSession.licenseRequest = messageB64;
      }

      // Update the captured session entry
      const entry = capturedSessions.find((s) => s.sessionId === sessionId);
      if (entry) {
        entry.licenseRequest = messageB64;
      }

      forwardToBackground({
        type: "licenseRequest",
        sessionId,
        messageType,
        message: messageB64,
        keySystem,
      });
    } else if (messageType === "license-release") {
      // License release — clean up
      activeSessions.delete(sessionId);
    }
  });

  // Intercept the keystatuseschange event to detect when keys are available
  session.addEventListener("keystatuseschange", function onKeyStatusesChange() {
    if (session.keyStatuses) {
      const keyStatuses = [];
      for (let i = 0; i < session.keyStatuses.length; i++) {
        const keyId = session.keyStatuses.get(i);
        const status = session.keyStatuses.getStatusForKeyId(keyId);
        if (keyId && status) {
          const keyIdArray = new Uint8Array(keyId);
          let keyIdHex = "";
          for (let j = 0; j < keyIdArray.length; j++) {
            keyIdHex += keyIdArray[j].toString(16).padStart(2, "0");
          }
          keyStatuses.push({ keyId: keyIdHex, status });
        }
      }

      if (keyStatuses.length > 0) {
        const activeSession = activeSessions.get(sessionId);
        if (activeSession) {
          activeSession.keyStatuses = keyStatuses;
        }

        forwardToBackground({
          type: "keyStatuses",
          sessionId,
          keyStatuses,
          keySystem,
        });
      }
    }
  });

  return session;
}

// ─── MediaKeySystemAccess Wrapper ───────────────────────────────────────────

/**
 * Create a proxy for a MediaKeySystemAccess that intercepts
 * createMediaKeys() to wrap the resulting sessions.
 *
 * @param {MediaKeySystemAccess} access - The original access object.
 * @param {string} keySystem - The key system identifier.
 * @returns {MediaKeySystemAccess} The proxied access object.
 */
function proxyMediaKeySystemAccess(access, keySystem) {
  const originalCreateMediaKeys = access.createMediaKeys.bind(access);

  access.createMediaKeys = async function () {
    const mediaKeys = await originalCreateMediaKeys();

    if (mediaKeys && typeof mediaKeys.createSession === "function") {
      const originalCreateSession = mediaKeys.createSession.bind(mediaKeys);

      mediaKeys.createSession = function (sessionType) {
        const session = originalCreateSession(sessionType);
        return proxyMediaKeySession(session, keySystem);
      };
    }

    return mediaKeys;
  };

  return access;
}

// ─── navigator.requestMediaKeySystemAccess Interception ─────────────────────

/**
 * Intercepted version of navigator.requestMediaKeySystemAccess.
 *
 * Captures the key system and initial configuration data, then
 * wraps the returned MediaKeySystemAccess to intercept session
 * creation and license exchanges.
 *
 * @param {string} keySystem - The key system identifier.
 * @param {MediaKeySystemConfiguration[]} supportedConfigurations
 * @returns {Promise<MediaKeySystemAccess>}
 */
async function interceptedRequestMediaKeySystemAccess(keySystem, supportedConfigurations) {
  // Capture init data types from the configuration
  const initDataTypes = [];
  if (supportedConfigurations) {
    for (const config of supportedConfigurations) {
      if (config.initDataTypes) {
        initDataTypes.push(...config.initDataTypes);
      }
    }
  }

  // originalRequestMediaKeySystemAccess is already bound to navigator in init()
  const result = await originalRequestMediaKeySystemAccess(
    keySystem,
    supportedConfigurations,
  );

  if (!isActive) {
    return result;
  }

  return proxyMediaKeySystemAccess(result, keySystem);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the EME interception module.
 *
 * Overrides navigator.requestMediaKeySystemAccess with a wrapped
 * version that intercepts PSSH init data, license requests, and
 * license responses.
 */
function init() {
  if (isActive) {
    return;
  }

  if (typeof navigator === "undefined" || typeof navigator.requestMediaKeySystemAccess !== "function") {
    // EME API not available in this environment
    return;
  }

  originalRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess.bind(navigator);
  navigator.requestMediaKeySystemAccess = interceptedRequestMediaKeySystemAccess;
  isActive = true;
}

/**
 * Clean up the EME interception module.
 *
 * Restores the original navigator.requestMediaKeySystemAccess and
 * clears all captured session data.
 */
function cleanup() {
  isActive = false;

  if (originalRequestMediaKeySystemAccess && navigator) {
    navigator.requestMediaKeySystemAccess = originalRequestMediaKeySystemAccess;
    originalRequestMediaKeySystemAccess = null;
  }

  capturedSessions.length = 0;
  activeSessions.clear();
}

/**
 * Get all captured EME session data.
 *
 * @returns {Array<Object>} Array of captured session objects.
 */
function getCapturedData() {
  return [...capturedSessions];
}

/**
 * Get active sessions that are still pending (init data captured,
 * license exchange in progress).
 *
 * @returns {Array<Object>} Array of active session objects.
 */
function getActiveSessions() {
  return Array.from(activeSessions.values());
}

/**
 * Check if a string looks like an EME init data type identifier
 * (e.g., "cenc", "webm", "keyids").
 *
 * @param {string} value - The value to check.
 * @returns {boolean} True if the value is an init data type.
 */
function isInitDataType(value) {
  if (!value || typeof value !== "string") {
    return false;
  }
  return ["cenc", "keyids", "webm"].includes(value.toLowerCase().trim());
}

export {
  init,
  cleanup,
  getCapturedData,
  getActiveSessions,
  isInitDataType,
};
