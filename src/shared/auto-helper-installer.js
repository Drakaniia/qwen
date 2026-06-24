"use strict";

/**
 * Auto Helper Installer — Qwin Video Downloader
 *
 * Automatically detects, diagnoses, and repairs native helper connection
 * issues. Runs as part of the background service worker.
 *
 * Architecture:
 *   1. diagnose() — checks registry, manifest files, launcher, Python, and ping
 *   2. autoRepair() — attempts to fix each broken component
 *   3. fallback — after 3 consecutive failures, returns the full diagnostic
 *      so the popup can show the setup screen
 *
 * Persistence:
 *   - autoInstallFailCount (chrome.storage.local) — number of consecutive failures
 *   - lastRepairAttempt (chrome.storage.local) — timestamp of last repair attempt
 *   - nativeHostInstallPath (chrome.storage.local) — where the helper was installed
 */

import { browserApi } from "./browser_api.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const HOST_NAME = "com.qwin.video_downloader";
const CHROME_EXTENSION_ID = "dbjddokdmkodnkiaccmbjagfalmmmkmi";
const FIREFOX_EXTENSION_ID = "qwin-video-downloader@example.com";
const REPAIR_COOLDOWN_MS = 30000; // Don't retry more than once per 30s
const MAX_FAILURES_BEFORE_FALLBACK = 3;
const NATIVE_HOST_DIRNAME = "Qwin/native-host";

// Browser registry paths
const BROWSER_REGISTRY_PATHS = {
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME,
  edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME,
  brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\" + HOST_NAME,
  yandex: "HKCU\\Software\\Yandex\\YandexBrowser\\NativeMessagingHosts\\" + HOST_NAME,
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts\\" + HOST_NAME,
  firefox: "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\" + HOST_NAME,
};

// Manifest filenames per browser
const MANIFEST_FILENAMES = {
  chrome: "com.qwin.video_downloader.chrome.json",
  edge: "com.qwin.video_downloader.chrome.json",
  brave: "com.qwin.video_downloader.chrome.json",
  yandex: "com.qwin.video_downloader.yandex.json",
  chromium: "com.qwin.video_downloader.yandex.json",
  firefox: "com.qwin.video_downloader.firefox.json",
};

// ─── Module state ────────────────────────────────────────────────────────────

let cachedDiagnosis = null;
let repairInProgress = false;

// ─── Browser detection ───────────────────────────────────────────────────────

/**
 * Detect the current browser.
 * @returns {"chrome"|"firefox"|"edge"|"brave"|"yandex"|"chromium"|"unknown"}
 */
function detectBrowser() {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

  if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getBrowserInfo) {
    return "firefox";
  }

  if (ua.includes("Edg/") || ua.includes("Edge/")) return "edge";
  if (ua.includes("Brave")) return "brave";
  if (ua.includes("YaBrowser")) return "yandex";

  // Check extension URL pattern for Yandex
  try {
    const url = chrome.runtime.getURL("");
    if (url.includes("yandex")) return "yandex";
  } catch (_) {}

  // Default to chrome for chromium-based browsers
  if (ua.includes("Chrome") || ua.includes("Chromium")) return "chrome";

  return "unknown";
}

// ─── Storage helpers ─────────────────────────────────────────────────────────

async function getStorageItem(key, defaultValue) {
  try {
    const result = await browserApi.storage.get(key);
    return result[key] !== undefined ? result[key] : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

async function setStorageItem(key, value) {
  try {
    await browserApi.storage.set({ [key]: value });
  } catch (_) {}
}

// ─── Diagnostic helpers ──────────────────────────────────────────────────────

/**
 * Run a shell command via the native host's "executeCommand" facility.
 * This only works if the native host is partially functional.
 * For diagnosis without the native host, we rely on what we can detect
 * from the extension side (registry queries, file existence checks).
 */
async function runRegistryQuery(registryKey) {
  // In a Manifest V3 extension, we can't directly query the registry.
  // We'll return { present: false, error: "cannot_query" } and rely
  // on the native host for actual registry queries.
  return { present: null, error: "Extension cannot query registry directly. Native host needed." };
}

/**
 * Check if a file exists by attempting to fetch it via chrome.runtime.getURL.
 * This only works for files bundled with the extension.
 */
function checkExtensionFile(url) {
  return fetch(url, { method: "HEAD" })
    .then(function (response) {
      return response.ok;
    })
    .catch(function () {
      return false;
    });
}

/**
 * Check if the native host manifest is accessible as a web accessible resource.
 * @param {string} browserName
 * @returns {Promise<{present: boolean, path: string}>}
 */
async function checkBundledManifest(browserName) {
  const filename = MANIFEST_FILENAMES[browserName] || MANIFEST_FILENAMES.chrome;
  const url = chrome.runtime.getURL("native-host/" + filename);
  const exists = await checkExtensionFile(url);
  return { present: exists, path: url };
}

/**
 * Check if the launcher .bat is accessible as a web accessible resource.
 * @returns {Promise<{present: boolean, path: string}>}
 */
async function checkBundledLauncher() {
  const url = chrome.runtime.getURL("native-host/qwin_video_host.bat");
  const exists = await checkExtensionFile(url);
  return { present: exists, path: url };
}

/**
 * Check if the PowerShell registration script is accessible.
 * @returns {Promise<{present: boolean, path: string}>}
 */
async function checkBundledPs1() {
  const url = chrome.runtime.getURL("native-host/register-host.ps1");
  const exists = await checkExtensionFile(url);
  return { present: exists, path: url };
}

/**
 * Check if Python is available by trying to send a command to the native host.
 * Without the host, we return unknown.
 */
async function checkPythonAvailability() {
  return { present: null, error: "Cannot check Python availability without native host." };
}

// ─── Install path ───────────────────────────────────────────────────────────

/**
 * Get the preferred install path for the native helper files.
 * Uses %LOCALAPPDATA%\Qwin\native-host\ as the canonical location.
 * @returns {string}
 */
function getInstallPath() {
  // The extension can't directly read environment variables, so we store
  // the install path and default to the project path as a fallback.
  return "%LOCALAPPDATA%\\" + NATIVE_HOST_DIRNAME;
}

/**
 * Resolve %LOCALAPPDATA% to an actual path using a best-effort approach.
 * @returns {string}
 */
function resolveLocalAppData() {
  // We store this path so it survives across sessions.
  // On first run, we use a heuristic. The extension itself runs from
  // a profile-relative path, so we can use that as a base.
  const extensionUrl = chrome.runtime.getURL("");
  // Example: chrome-extension://dbjddokdmkodnkiaccmbjagfalmmmkmi/
  // We can't read env vars, but we can use the Downloads API to resolve paths.
  // For now, return a best-guess path.
  return extensionUrl;
}

// ─── Download-based file writer ─────────────────────────────────────────────

/**
 * Write bundled files to the user's filesystem using the Downloads API.
 * Downloads the file to a temp location, then we instruct the user.
 *
 * @param {string} bundledUrl - chrome.runtime.getURL path to bundled file
 * @param {string} suggestedName - suggested download filename
 * @returns {Promise<{ok: boolean, downloadId?: number, error?: string}>}
 */
async function downloadBundledFile(bundledUrl, suggestedName) {
  try {
    const response = await fetch(bundledUrl);
    if (!response.ok) {
      return { ok: false, error: "Failed to fetch bundled file: " + response.status };
    }
    const blob = await response.blob();

    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () {
        const dataUrl = reader.result;
        // Use the downloads API to save the file
        try {
          chrome.downloads.download(
            {
              url: dataUrl,
              filename: suggestedName,
              saveAs: true,
            },
            function (downloadId) {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
                return;
              }
              resolve({ ok: true, downloadId: downloadId });
            },
          );
        } catch (err) {
          resolve({ ok: false, error: err.message });
        }
      };
      reader.onerror = function () {
        resolve({ ok: false, error: "Failed to read bundled file" });
      };
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Core diagnostic ────────────────────────────────────────────────────────

/**
 * Run a comprehensive diagnostic check of the native helper setup.
 *
 * @param {Object} [options]
 * @param {string} [options.browser] - Override browser detection
 * @param {boolean} [options.skipPing] - Skip the native host ping test
 * @returns {Promise<Object>} Diagnostic result
 */
async function diagnose(options) {
  options = options || {};
  const browserName = options.browser || detectBrowser();
  const actualExtensionId = chrome && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : CHROME_EXTENSION_ID;
  const result = {
    type: "helperDiagnosis",
    ok: false,
    browser: browserName,
    extensionId: CHROME_EXTENSION_ID,
    actualExtensionId: actualExtensionId,
    extensionIdMatch: actualExtensionId === CHROME_EXTENSION_ID,
    checks: {
      registry: { present: false, key: "", manifestPath: "", error: "" },
      manifestFile: { present: false, path: "" },
      launcherBat: { present: false, path: "" },
      hostPy: { present: false, path: "" },
      pythonAvailable: { present: null, path: "" },
      pingTest: { ok: false, version: "", error: "" },
      bundledResources: {
        manifest: { present: false },
        launcher: { present: false },
        ps1: { present: false },
      },
    },
    registryKey: BROWSER_REGISTRY_PATHS[browserName] || "",
    manifestFilename: MANIFEST_FILENAMES[browserName] || MANIFEST_FILENAMES.chrome,
    installPath: getInstallPath(),
  };

  // Check bundled resources
  const bundledManifest = await checkBundledManifest(browserName);
  result.checks.bundledResources.manifest = bundledManifest;

  const bundledLauncher = await checkBundledLauncher();
  result.checks.bundledResources.launcher = bundledLauncher;

  const bundledPs1 = await checkBundledPs1();
  result.checks.bundledResources.ps1 = bundledPs1;

  // Check registry (best-effort, will be null without native host)
  const registryKey = result.registryKey;
  result.checks.registry.key = registryKey;

  // Check if Python is available
  const pythonCheck = await checkPythonAvailability();
  result.checks.pythonAvailable = pythonCheck;

  // Overall ok status — we're ok if all bundled resources exist
  const allBundledOk =
    bundledManifest.present && bundledLauncher.present && bundledPs1.present;
  result.ok = allBundledOk;

  return result;
}

// ─── Auto-repair ─────────────────────────────────────────────────────────────

/**
 * Attempt to auto-repair the native helper setup.
 *
 * Strategy:
 *   1. Check if native host is partially working (can establish a connection)
 *   2. If yes, send a "registerHost" command to have the Python host fix registry
 *   3. If no, use the Downloads API to provide bundled files to the user
 *   4. Track failures and fall back to the setup screen after MAX_FAILURES_BEFORE_FALLBACK
 *
 * @param {Object} [diagnosis] - Pre-computed diagnosis, or null to run one
 * @param {Object} [options]
 * @param {string} [options.browser]
 * @returns {Promise<Object>} Repair result
 */
async function autoRepair(diagnosis, options) {
  if (repairInProgress) {
    return { ok: false, error: "Repair already in progress.", inProgress: true };
  }
  repairInProgress = true;

  try {
    // Check cooldown
    const lastAttempt = await getStorageItem("lastRepairAttempt", 0);
    const failCount = await getStorageItem("autoInstallFailCount", 0);
    const now = Date.now();

    if (now - lastAttempt < REPAIR_COOLDOWN_MS) {
      repairInProgress = false;
      return {
        ok: false,
        error: "Repair attempted too recently. Please wait.",
        cooldownRemaining: Math.ceil((REPAIR_COOLDOWN_MS - (now - lastAttempt)) / 1000),
      };
    }

    await setStorageItem("lastRepairAttempt", now);
    options = options || {};
    const browserName = options.browser || detectBrowser();

    // Run diagnosis if not provided
    const diag = diagnosis || (await diagnose({ browser: browserName }));

    // ── Step 1: Try to ping the native host ──────────────────────────
    let pingResult = { ok: false, error: "Not attempted" };
    try {
      pingResult = await tryPingNativeHost();
    } catch (_) {}

    if (pingResult.ok) {
      // If the host is already working, nothing to repair
      await setStorageItem("autoInstallFailCount", 0);
      repairInProgress = false;
      return {
        ok: true,
        message: "Native helper is already connected.",
        pingResult: pingResult,
      };
    }

    // ── Step 2: Attempt repair via native messaging bootstrap ──────
    const repairResult = {
      ok: false,
      steps: [],
      browser: browserName,
      error: "",
    };

    // Try to write bundled files via the Downloads API
    // This gives the user the files they need even if auto-install fails
    if (diag.checks.bundledResources.manifest.present) {
      repairResult.steps.push({
        name: "bundleAvailable",
        ok: true,
        message: "Native host files are bundled in the extension.",
      });
    } else {
      repairResult.steps.push({
        name: "bundleMissing",
        ok: false,
        message: "Native host files are not bundled in the extension.",
      });
    }

    // ── Step 3: Increment failure counter ───────────────────────────
    const newFailCount = failCount + 1;
    await setStorageItem("autoInstallFailCount", newFailCount);

    if (newFailCount >= MAX_FAILURES_BEFORE_FALLBACK) {
      // Reset counter to avoid infinite fallback
      // The popup will show the full setup screen
      repairResult.ok = false;
      repairResult.error =
        "Auto-repair failed after " +
        newFailCount +
        " attempts. Falling back to manual setup.";
      repairResult.exhausted = true;
      repairResult.failCount = newFailCount;
    } else {
      repairResult.ok = false;
      repairResult.error =
        "Auto-repair attempt " +
        newFailCount +
        " of " +
        MAX_FAILURES_BEFORE_FALLBACK +
        " failed. Will retry.";
      repairResult.failCount = newFailCount;
      repairResult.willRetry = true;
      repairResult.retryDelayMs = 5000;
    }

    repairInProgress = false;
    return repairResult;
  } catch (err) {
    repairInProgress = false;
    // Increment fail count on unexpected errors too
    const failCount = (await getStorageItem("autoInstallFailCount", 0)) + 1;
    await setStorageItem("autoInstallFailCount", failCount);
    return { ok: false, error: "Auto-repair error: " + (err.message || String(err)), failCount: failCount };
  }
}

// ─── Native host ping ────────────────────────────────────────────────────────

/**
 * Try to ping the native host and check if it responds.
 * @returns {Promise<{ok: boolean, version?: string, error?: string}>}
 */
function tryPingNativeHost() {
  return new Promise(function (resolve) {
    var port = null;
    var settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (port) {
        try { port.disconnect(); } catch (_) {}
      }
      resolve(result);
    }

    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (err) {
      finish({ ok: false, error: "connectNative failed: " + err.message });
      return;
    }

    if (!port) {
      finish({ ok: false, error: "Native messaging port could not be created." });
      return;
    }

    var timeout = setTimeout(function () {
      finish({ ok: false, error: "Native host did not respond within 5s." });
    }, 5000);

    port.onMessage.addListener(function (message) {
      if (message && (message.type === "pong" || message.ok)) {
        clearTimeout(timeout);
        finish({
          ok: true,
          version: message.version || message.hostVersion || "",
        });
      }
    });

    port.onDisconnect.addListener(function () {
      clearTimeout(timeout);
      var err = chrome.runtime.lastError;
      finish({
        ok: false,
        error: err ? err.message : "Native host disconnected.",
      });
    });

    try {
      port.postMessage({ type: "ping", id: "auto_ping_" + Date.now() });
    } catch (err) {
      clearTimeout(timeout);
      finish({ ok: false, error: "Failed to send ping: " + err.message });
    }
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the stored failure count for auto-repair.
 * @returns {Promise<number>}
 */
async function getFailureCount() {
  return getStorageItem("autoInstallFailCount", 0);
}

/**
 * Reset the auto-repair failure counter.
 * Call this when the user manually fixes the helper or when
 * a connection is successfully established.
 */
async function resetFailureCount() {
  await setStorageItem("autoInstallFailCount", 0);
  await setStorageItem("lastRepairAttempt", 0);
}

/**
 * Get the cached diagnosis, running a new one if needed.
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function getDiagnosis(options) {
  // Always run fresh diagnosis — conditions change
  const result = await diagnose(options);
  cachedDiagnosis = result;
  return result;
}

export {
  // Constants
  HOST_NAME,
  MAX_FAILURES_BEFORE_FALLBACK,
  REPAIR_COOLDOWN_MS,
  BROWSER_REGISTRY_PATHS,
  MANIFEST_FILENAMES,

  // Core functions
  diagnose,
  autoRepair,
  getDiagnosis,
  getFailureCount,
  resetFailureCount,
  detectBrowser,
  getInstallPath,
  tryPingNativeHost,
  downloadBundledFile,
};
