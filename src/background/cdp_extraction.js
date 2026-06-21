"use strict";

/**
 * CDP-based URL Extraction Module
 *
 * Uses Chrome DevTools Protocol (via chrome.debugger) to extract video source
 * URLs from dynamically-loaded pages. This handles sites where yt-dlp cannot
 * find the media URL, such as:
 * - Custom HTML5 video players
 * - Anti-bot protected pages (Cloudflare, etc.)
 * - Pages with __NEXT_DATA__ / __NUXT__ / playerConfig
 *
 * Strategy (§5.1, §5.5):
 * 1. Attach CDP to the target tab via chrome.debugger
 * 2. Use Runtime.evaluate to inject an extraction script that runs in page context
 * 3. The script finds video sources from DOM elements and JS config objects
 * 4. Results are returned as structured video candidate objects
 *
 * This module uses chrome.debugger directly (not through the relay chain)
 * because it runs synchronously in the background script's own execution context.
 */

// ─── Active sessions ───────────────────────────────────────────────────────

/** @type {Map<number, boolean>} */
const activeSessions = new Map();

// ─── Extraction Script ─────────────────────────────────────────────────────

/**
 * Returns a self-executing JavaScript function as a string that, when evaluated
 * in the page context via Runtime.evaluate, extracts video source URLs.
 *
 * The script looks for:
 * 1. <video> elements with `src` attributes
 * 2. <source> elements inside <video>
 * 3. window.__NEXT_DATA__.props (Next.js pages)
 * 4. window.__NUXT__ (Nuxt.js pages)
 * 5. window.playerConfig (custom players)
 * 6. Inline script content with media URL patterns
 *
 * @returns {string} A JavaScript expression that evaluates to an array of video source objects.
 */
function getExtractionScript() {
  return `(function() {
  var results = [];
  var urls = new Set();

  function addSource(url, type, sourceName, extra) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    try { new URL(url); } catch(e) { return; }
    var key = url;
    if (urls.has(key)) return;
    urls.add(key);
    var entry = { url: url, type: type || '', source: sourceName || 'unknown' };
    if (extra) {
      if (extra.width) entry.width = extra.width;
      if (extra.height) entry.height = extra.height;
      if (extra.duration) entry.duration = extra.duration;
    }
    results.push(entry);
  }

  // 1. <video> elements with direct src
  try {
    document.querySelectorAll('video').forEach(function(v) {
      if (v.src && !v.src.startsWith('blob:') && !v.src.startsWith('data:')) {
        var rect = v.getBoundingClientRect();
        addSource(v.src, v.type || '', 'video-src', {
          width: v.videoWidth || rect.width,
          height: v.videoHeight || rect.height,
          duration: v.duration
        });
      }
    });
  } catch(e) {}

  // 2. <source> elements inside <video>
  try {
    document.querySelectorAll('video source[src]').forEach(function(s) {
      if (s.src && !s.src.startsWith('blob:') && !s.src.startsWith('data:')) {
        addSource(s.src, s.type || '', 'video-source');
      }
    });
  } catch(e) {}

  // 3. <source> elements with src (standalone, e.g. audio)
  try {
    document.querySelectorAll('source[src]').forEach(function(s) {
      if (s.src && !s.src.startsWith('blob:') && !s.src.startsWith('data:')) {
        var parent = s.parentElement;
        if (parent && (parent.tagName === 'VIDEO' || parent.tagName === 'AUDIO')) {
          addSource(s.src, s.type || '', 'media-source');
        }
      }
    });
  } catch(e) {}

  // 4. window.__NEXT_DATA__ (Next.js)
  try {
    if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props) {
      walkObject(window.__NEXT_DATA__, results, addSource, urls);
    }
  } catch(e) {}

  // 5. window.__NUXT__ (Nuxt.js/Vue)
  try {
    if (window.__NUXT__) {
      walkObject(window.__NUXT__, results, addSource, urls);
    }
  } catch(e) {}

  // 6. window.playerConfig (custom players like JW Player, etc.)
  try {
    if (window.playerConfig) {
      walkObject(window.playerConfig, results, addSource, urls);
    }
  } catch(e) {}

  // 7. Inline scripts with media URL patterns
  try {
    document.querySelectorAll('script:not([src])').forEach(function(s) {
      var text = s.textContent || '';
      if (text.length > 50000) return; // skip very large scripts
      var mediaRe = /https?:\\\\?\\/\\\\?\\/[^"' \\\\n\\\\r<>]+?\\.(mp4|m3u8|mpd|webm)(?:[?#][^"' \\\\n\\\\r<>]*)?/gi;
      var match;
      while ((match = mediaRe.exec(text)) !== null) {
        var url = match[0].replace(/\\\\\\\\\\//g, '/');
        addSource(url, '', 'inline-script');
      }
    });
  } catch(e) {}

  return results;

  function walkObject(obj, results, addSource, urls) {
    if (!obj || typeof obj !== 'object') return;
    var seen = new WeakSet();
    var queue = [obj];
    while (queue.length) {
      var item = queue.shift();
      if (!item || typeof item !== 'object') continue;
      try { if (seen.has(item)) continue; seen.add(item); } catch(e) { continue; }
      for (var key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        try {
          var val = item[key];
          if (typeof val === 'string' && val.length > 5 && val.length < 2000) {
            if (/^(https?:)?\\\\?\\/\\\\?\\/[^"' \\\\n\\\\r<>]+?\\.(mp4|m3u8|mpd|webm)([?#]|$)/i.test(val)) {
              var cleanUrl = val.replace(/\\\\\\\\\\//g, '/');
              addSource(cleanUrl, '', 'js-config-' + key);
            }
          } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            queue.push(val);
          } else if (Array.isArray(val) && val.length < 100) {
            val.forEach(function(v) { if (v && typeof v === 'object') queue.push(v); });
          }
        } catch(e) {}
      }
    }
  }
})()`;
}

// ─── CDP Integration ───────────────────────────────────────────────────────

/**
 * Attach the debugger to a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
function attach(tabId) {
  if (activeSessions.has(tabId)) {
    return Promise.resolve({ ok: true });
  }

  return new Promise((resolve) => {
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "Failed to attach debugger" });
          return;
        }
        activeSessions.set(tabId, true);
        resolve({ ok: true });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

/**
 * Detach the debugger from a tab.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean}>}
 */
function detach(tabId) {
  if (!activeSessions.has(tabId)) {
    return Promise.resolve({ ok: true });
  }

  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => {
        activeSessions.delete(tabId);
        resolve({ ok: true });
      });
    } catch (_error) {
      activeSessions.delete(tabId);
      resolve({ ok: true });
    }
  });
}

/**
 * Send a CDP command via chrome.debugger.sendCommand.
 * @param {number} tabId
 * @param {string} method
 * @param {Object} [params]
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
function sendCommand(tabId, method, params) {
  return new Promise((resolve) => {
    if (!activeSessions.has(tabId)) {
      resolve({ ok: false, error: "Debugger is not attached to this tab." });
      return;
    }

    try {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ ok: false, error: lastError.message || "CDP command failed" });
          return;
        }
        resolve({ ok: true, result });
      });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
    }
  });
}

/**
 * Extract video sources from a tab using CDP.
 *
 * Flow:
 * 1. Attach CDP to the tab
 * 2. Inject the extraction script via Runtime.evaluate
 * 3. Parse the returned video sources
 * 4. Optionally detach (or keep attached for future use)
 *
 * @param {number} tabId - The browser tab ID to extract from.
 * @param {Object} [options]
 * @param {number} [options.timeout=15000] - Maximum time to wait for extraction (ms).
 * @param {boolean} [options.detachAfter=true] - Whether to detach CDP after extraction.
 * @returns {Promise<{ok: boolean, videos: Array, error?: string}>}
 */
async function extractVideosFromTab(tabId, options = {}) {
  const timeout = options.timeout || 15000;
  const detachAfter = options.detachAfter !== false;

  if (!tabId || !Number.isInteger(tabId)) {
    return { ok: false, videos: [], error: "Invalid tabId: must be a positive integer." };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, videos: [], error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Inject extraction script via Runtime.evaluate
  const script = getExtractionScript();
  const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
    timeout: timeout,
  });

  if (!evaluateResult.ok) {
    if (detachAfter) {
      await detach(tabId);
    }
    return { ok: false, videos: [], error: evaluateResult.error || "Runtime.evaluate failed." };
  }

  // Parse the extraction result
  const resultValue = evaluateResult.result;
  let videos = [];

  try {
    if (
      resultValue &&
      resultValue.result &&
      resultValue.result.type === "object" &&
      Array.isArray(resultValue.result.value)
    ) {
      videos = resultValue.result.value;
    }
  } catch (_error) {
    // Malformed result, treat as empty
  }

  if (detachAfter) {
    await detach(tabId);
  }

  return { ok: true, videos };
}

/**
 * Clean up all active CDP sessions.
 */
function cleanup() {
  const tabIds = Array.from(activeSessions.keys());
  for (const tabId of tabIds) {
    try {
      chrome.debugger.detach({ tabId });
    } catch (_error) {
      // Session may already be detached
    }
    activeSessions.delete(tabId);
  }
}

export { getExtractionScript, extractVideosFromTab, cleanup };
