"use strict";

/**
 * P2P / WebRTC Stream Detection Module
 *
 * Intercepts RTCPeerConnection and detects WebTorrent/PeerTube/P2P
 * video streams that deliver content through WebRTC data channels
 * or peer-to-peer protocols instead of standard HTTP.
 *
 * Detection:
 * 1. Intercept RTCPeerConnection constructor to capture stream URLs
 * 2. Detect WebTorrent instances (window.WebTorrent)
 * 3. Flag tabs with P2P activity for the background script
 */

/** @type {object} */
function getExtensionApi() {
  if (typeof browser !== "undefined") return browser;
  if (typeof chrome !== "undefined") return chrome;
  return { runtime: { sendMessage() {} } };
}

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Set<string>} */
const detectedP2pUrls = new Set();

/** @type {Set<RTCPeerConnection>} */
const interceptedConnections = new WeakSet();

let originalRTCPeerConnection = null;
let isActive = false;

/** @type {number|null} */
let scanIntervalId = null;

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  /** Maximum number of P2P URLs to track per page. */
  maxTrackedUrls: 20,
  /** Whether to forward detected P2P streams to background. */
  autoForward: true,
};

// ─── P2P detection helpers ──────────────────────────────────────────────────

/**
 * Check if a URL string is likely a P2P/WebTorrent media URL.
 * @param {string} url
 * @returns {boolean}
 */
function isLikelyP2pMediaUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  const text = url.toLowerCase();

  // WebTorrent / BitTorrent URLs
  if (text.startsWith("magnet:") || text.startsWith("torrent:")) {
    return true;
  }
  if (text.endsWith(".torrent")) {
    return true;
  }

  // WebTorrent info hash URLs
  if (/^[a-f0-9]{40}$/i.test(text)) {
    return true;
  }

  return false;
}

/**
 * Check for WebTorrent in the page context.
 * @returns {boolean}
 */
function hasWebTorrent() {
  try {
    if (typeof window !== "undefined") {
      // @ts-ignore
      return Boolean(window.WebTorrent) || Boolean(window.WebTorrentClients);
    }
  } catch (_error) {
    // Cross-origin restrictions
  }
  return false;
}

/**
 * Check for PeerTube or other P2P streaming frameworks.
 * @returns {boolean}
 */
function hasP2pFramework() {
  try {
    if (typeof window !== "undefined") {
      // PeerTube
      // @ts-ignore
      if (window.peertube || document.querySelector('link[href*="peertube"]')) {
        return true;
      }
      // WebTorrent
      // @ts-ignore
      if (window.WebTorrent) {
        return true;
      }
      // P2P media loader (hls.js p2p plugin)
      // @ts-ignore
      if (window.P2PMediaLoader || window.DatArchive) {
        return true;
      }
    }
  } catch (_error) {
    // Cross-origin restrictions
  }
  return false;
}

/**
 * Extract URLs from an SDP offer/answer.
 * @param {string} sdp
 * @returns {string[]}
 */
function extractUrlsFromSdp(sdp) {
  const urls = [];
  if (!sdp || typeof sdp !== "string") {
    return urls;
  }

  // Extract media streams from SDP (a=msid, a=ssrc lines)
  const msidRegex = /a=msid:([^\r\n]+)/g;
  let match;
  while ((match = msidRegex.exec(sdp)) !== null) {
    const msid = match[1].trim();
    if (msid && !urls.includes(msid)) {
      urls.push(`webrtc-msid:${msid}`);
    }
  }

  // Extract ICE candidates with relevant URLs
  const candidateRegex = /a=candidate:[^\r\n]+/g;
  while ((match = candidateRegex.exec(sdp)) !== null) {
    const candidate = match[0];
    // Look for relay/TURN server URLs
    const turnMatch = candidate.match(/relay\s+([^\s]+)/);
    if (turnMatch && !urls.includes(turnMatch[1])) {
      urls.push(turnMatch[1]);
    }
  }

  return urls;
}

// ─── RTCPeerConnection Interception ────────────────────────────────────────

/**
 * Create a proxied version of an RTCPeerConnection instance.
 * Intercepts key methods to detect media URLs.
 *
 * @param {RTCPeerConnection} pc - The original peer connection
 * @returns {RTCPeerConnection} The proxied peer connection
 */
function proxyPeerConnection(pc) {
  if (interceptedConnections.has(pc)) {
    return pc;
  }
  interceptedConnections.add(pc);

  // Intercept createOffer
  const originalCreateOffer = pc.createOffer.bind(pc);
  pc.createOffer = async function (...args) {
    const offer = await originalCreateOffer(...args);
    if (offer && offer.sdp) {
      const urls = extractUrlsFromSdp(offer.sdp);
      for (const url of urls) {
        addDetectedP2pUrl(url, "webrtc-offer");
      }
    }
    return offer;
  };

  // Intercept createAnswer
  const originalCreateAnswer = pc.createAnswer.bind(pc);
  pc.createAnswer = async function (...args) {
    const answer = await originalCreateAnswer(...args);
    if (answer && answer.sdp) {
      const urls = extractUrlsFromSdp(answer.sdp);
      for (const url of urls) {
        addDetectedP2pUrl(url, "webrtc-answer");
      }
    }
    return answer;
  };

  // Intercept setLocalDescription
  const originalSetLocal = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async function (desc) {
    if (desc && desc.sdp) {
      const urls = extractUrlsFromSdp(desc.sdp);
      for (const url of urls) {
        addDetectedP2pUrl(url, "webrtc-local");
      }
    }
    return originalSetLocal(desc);
  };

  // Intercept setRemoteDescription
  const originalSetRemote = pc.setRemoteDescription.bind(pc);
  pc.setRemoteDescription = async function (desc) {
    if (desc && desc.sdp) {
      const urls = extractUrlsFromSdp(desc.sdp);
      for (const url of urls) {
        addDetectedP2pUrl(url, "webrtc-remote");
      }
    }
    return originalSetRemote(desc);
  };

  // Intercept onaddstream / ontrack for media stream detection
  if (pc.ontrack === undefined) {
    Object.defineProperty(pc, "ontrack", {
      set(fn) {
        const wrapper = (event) => {
          if (event && event.streams) {
            for (const stream of event.streams) {
              if (stream.id) {
                addDetectedP2pUrl(`webrtc-stream:${stream.id}`, "webrtc-track");
              }
            }
          }
          return fn.call(this, event);
        };
        this._qwinOntrack = wrapper;
        return wrapper;
      },
      get() {
        return this._qwinOntrack || null;
      },
      configurable: true,
    });
  }

  return pc;
}

/**
 * Intercepted RTCPeerConnection constructor.
 */
function InterceptedRTCPeerConnection(...args) {
  const pc = originalRTCPeerConnection ? new originalRTCPeerConnection(...args) : null;
  if (!pc) {
    return null;
  }
  return proxyPeerConnection(pc);
}

// Copy static methods (guard against null in test environments)
if (originalRTCPeerConnection && typeof originalRTCPeerConnection.generateCertificate === "function") {
  InterceptedRTCPeerConnection.generateCertificate = function (...args) {
    return originalRTCPeerConnection.generateCertificate(...args);
  };
}

// ─── Detection forwarding ───────────────────────────────────────────────────

/**
 * Add a detected P2P URL and optionally forward to background.
 * @param {string} url
 * @param {string} source
 */
function addDetectedP2pUrl(url, source) {
  if (!url || detectedP2pUrls.size >= CONFIG.maxTrackedUrls) {
    return;
  }

  if (detectedP2pUrls.has(url)) {
    return;
  }
  detectedP2pUrls.add(url);

  if (CONFIG.autoForward) {
    try {
      const api = getExtensionApi();
      api.runtime
        .sendMessage({
          type: "p2pDetectedUrl",
          p2pUrl: url,
          source,
        })
        .catch(() => {});
    } catch (_error) {
      // Extension context may be unavailable
    }
  }
}

// ─── Periodic page scan ────────────────────────────────────────────────────

/**
 * Scan the page for P2P frameworks and activity.
 * Called periodically and on demand.
 */
function scanPage() {
  const p2pFramework = hasP2pFramework();
  const webtorrentAvailable = hasWebTorrent();

  if (p2pFramework || webtorrentAvailable) {
    try {
      const api = getExtensionApi();
      api.runtime
        .sendMessage({
          type: "p2pFrameworkDetected",
          p2pFramework: true,
          webtorrent: webtorrentAvailable,
        })
        .catch(() => {});
    } catch (_error) {}
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize P2P/WebRTC detection.
 * Overrides RTCPeerConnection to intercept media stream URLs.
 */
function init() {
  if (isActive) {
    return;
  }

  if (typeof window === "undefined" || typeof RTCPeerConnection !== "function") {
    return;
  }

  originalRTCPeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = InterceptedRTCPeerConnection;
  isActive = true;

  // Initial page scan
  scanPage();

  // Periodic scan for P2P frameworks (store ID for cleanup)
  scanIntervalId = setInterval(scanPage, 5000);
}

/**
 * Clean up the P2P detection module.
 */
function cleanup() {
  isActive = false;

  // Clear the periodic scan interval
  if (scanIntervalId !== null) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }

  if (originalRTCPeerConnection && window) {
    window.RTCPeerConnection = originalRTCPeerConnection;
    originalRTCPeerConnection = null;
  }

  detectedP2pUrls.clear();
}

/**
 * Get all detected P2P URLs.
 * @returns {string[]}
 */
function getDetectedUrls() {
  return Array.from(detectedP2pUrls);
}

export { init, cleanup, getDetectedUrls, isLikelyP2pMediaUrl, hasWebTorrent, hasP2pFramework, extractUrlsFromSdp };
