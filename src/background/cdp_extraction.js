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
 *
 * Layer 2 enhancements (§2):
 * - Iframe recursion: extracts videos from child frames via Page.getFrameTree
 * - Shadow DOM traversal: finds videos inside open shadow roots
 * - Mutation watching: waits for dynamically-added video elements
 * - Event simulation: triggers load/play on lazy-loaded video elements
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
 * 1. <video> elements with `src` attributes (including inside shadow roots)
 * 2. <source> elements inside <video> (including inside shadow roots)
 * 3. window.__NEXT_DATA__.props (Next.js pages)
 * 4. window.__NUXT__ (Nuxt.js pages)
 * 5. window.playerConfig (custom players)
 * 6. Inline script content with media URL patterns
 *
 * Shadow DOM traversal (§2.2): recursively walks into open shadow roots
 * to find video elements that are hidden inside web component boundaries.
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

  // Helper: collect all video elements including those inside shadow roots
  function collectAllVideos(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    var videos = [];
    try {
      videos = Array.from(root.querySelectorAll('video'));
    } catch(e) {}
    // Traverse into open shadow roots
    try {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.shadowRoot && el.shadowRoot.mode === 'open') {
          videos = videos.concat(collectAllVideos(el.shadowRoot));
        }
      }
    } catch(e) {}
    return videos;
  }

  // Helper: collect all source elements including those inside shadow roots
  function collectAllSources(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    var sources = [];
    try {
      sources = Array.from(root.querySelectorAll(selector));
    } catch(e) {}
    // Traverse into open shadow roots
    try {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.shadowRoot && el.shadowRoot.mode === 'open') {
          sources = sources.concat(collectAllSources(el.shadowRoot, selector));
        }
      }
    } catch(e) {}
    return sources;
  }

  // 1. <video> elements with direct src (including shadow DOM)
  try {
    collectAllVideos(document).forEach(function(v) {
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

  // 2. <source> elements inside <video> (including shadow DOM)
  try {
    collectAllSources(document, 'video source[src]').forEach(function(s) {
      if (s.src && !s.src.startsWith('blob:') && !s.src.startsWith('data:')) {
        addSource(s.src, s.type || '', 'video-source');
      }
    });
  } catch(e) {}

  // 3. <source> elements with src (standalone, e.g. audio) — including shadow DOM
  try {
    collectAllSources(document, 'source[src]').forEach(function(s) {
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

/**
 * Returns an extraction script that sets up a MutationObserver to watch for
 * new video elements being added to the DOM (including inside shadow roots).
 *
 * The script performs an initial scan, then watches for mutations. It resolves
 * with the videos found when either videos are detected or the timeout expires.
 *
 * @param {number} [pollMs=500] - How often to check for new videos (ms).
 * @param {number} watchDurationMs - How long to watch before timing out (ms). If 0, watches indefinitely.
 * @returns {string} A self-executing async function that resolves to { videos, timedOut }.
 */
function getMutationWatchScript(pollMs, watchDurationMs) {
  const pollInterval = pollMs || 500;
  const duration = watchDurationMs || 10000;

  return `(function() {
  var pollInterval = ${pollInterval};
  var watchDuration = ${duration};
  var startTime = Date.now();
  var seenUrls = new Set();

  function addSource(url, type, sourceName, extra) {
    if (!url || typeof url !== 'string') return;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    try { new URL(url); } catch(e) { return; }
    var key = url;
    if (seenUrls.has(key)) return;
    seenUrls.add(key);
  }

  // Helper: collect all video elements including shadow roots
  function collectAllVideos(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    var videos = [];
    try { videos = Array.from(root.querySelectorAll('video')); } catch(e) {}
    try {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.shadowRoot && el.shadowRoot.mode === 'open') {
          videos = videos.concat(collectAllVideos(el.shadowRoot));
        }
      }
    } catch(e) {}
    return videos;
  }

  function scanVideos() {
    var results = [];
    var urls = new Set();
    try {
      collectAllVideos(document).forEach(function(v) {
        if (v.src && !v.src.startsWith('blob:') && !v.src.startsWith('data:')) {
          var key = v.src;
          if (!urls.has(key)) {
            urls.add(key);
            var rect = v.getBoundingClientRect();
            results.push({
              url: v.src,
              type: v.type || '',
              source: 'video-src',
              width: v.videoWidth || rect.width,
              height: v.videoHeight || rect.height,
              duration: v.duration
            });
          }
        }
      });
    } catch(e) {}
    return results;
  }

  // Set up MutationObserver
  return new Promise(function(resolve) {
    var videos = scanVideos();
    if (videos.length > 0) {
      resolve({ videos: videos, timedOut: false });
      return;
    }

    var observer = new MutationObserver(function() {
      videos = scanVideos();
      if (videos.length > 0) {
        observer.disconnect();
        resolve({ videos: videos, timedOut: false });
      }
    });

    try {
      observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'type']
      });
    } catch(e) {}

    // Also watch shadow roots for mutations
    function watchShadowRoots(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      try {
        var all = root.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.shadowRoot && el.shadowRoot.mode === 'open') {
            try {
              var shadowObserver = new MutationObserver(function() {
                videos = scanVideos();
                if (videos.length > 0) {
                  shadowObserver.disconnect();
                  resolve({ videos: videos, timedOut: false });
                }
              });
              shadowObserver.observe(el.shadowRoot, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src', 'type']
              });
            } catch(e) {}
            watchShadowRoots(el.shadowRoot);
          }
        }
      } catch(e) {}
    }
    watchShadowRoots(document);

    // Polling fallback
    var pollTimer = setInterval(function() {
      videos = scanVideos();
      if (videos.length > 0) {
        clearInterval(pollTimer);
        observer.disconnect();
        resolve({ videos: videos, timedOut: false });
      }
    }, pollInterval);

    // Timeout
    setTimeout(function() {
      clearInterval(pollTimer);
      observer.disconnect();
      resolve({ videos: [], timedOut: true });
    }, watchDuration);
  });
})()`;
}

/**
 * Returns a script that triggers load() and play() events on video elements
 * matching the given URLs. Used to force lazy-loaded players to initialize.
 *
 * @param {string[]} videoUrls - Array of video URLs to target.
 * @returns {string} A self-executing async function that resolves to { triggered, loadCount, playCount }.
 */
function getEventSimulationScript(videoUrls) {
  const urlsJson = JSON.stringify(videoUrls || []);

  return `(function() {
  var targetUrls = ${urlsJson};
  if (!targetUrls || targetUrls.length === 0) {
    return { triggered: false, loadCount: 0, playCount: 0, reason: 'no-urls' };
  }

  var loadCount = 0;
  var playCount = 0;
  var urlSet = new Set(targetUrls);

  function collectAllVideos(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    var videos = [];
    try { videos = Array.from(root.querySelectorAll('video')); } catch(e) {}
    try {
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.shadowRoot && el.shadowRoot.mode === 'open') {
          videos = videos.concat(collectAllVideos(el.shadowRoot));
        }
      }
    } catch(e) {}
    return videos;
  }

  try {
    collectAllVideos(document).forEach(function(v) {
      var videoUrl = v.currentSrc || v.src || '';
      if (urlSet.has(videoUrl) || urlSet.has(videoUrl.split('?')[0])) {
        try { v.load(); loadCount++; } catch(e) {}
        try { var playPromise = v.play(); if (playPromise && typeof playPromise.then === 'function') { playPromise.catch(function(){}); } playCount++; } catch(e) {}
      }
    });
  } catch(e) {}

  return { triggered: loadCount > 0 || playCount > 0, loadCount: loadCount, playCount: playCount };
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

// ─── Iframe Discovery (Layer 2, §2.1) ─────────────────────────────────────

/**
 * Discover all frames in a tab using CDP Page.getFrameTree.
 *
 * Returns a flat array of all frames (top-level + children recursively),
 * each with frameId, url, and parentId (for child frames).
 *
 * @param {number} tabId - The browser tab ID.
 * @returns {Promise<{ok: boolean, frames?: Array<{frameId: string, url: string, parentId?: string}>, error?: string}>}
 */
async function discoverFrameTree(tabId) {
  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, frames: [], error: "Invalid tabId: must be a positive integer." };
  }

  // Attach if not already attached
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, frames: [], error: attachResult.error || "Could not attach debugger to discover frame tree." };
  }

  // Enable Page domain first
  await sendCommand(tabId, "Page.enable", {});

  // Get frame tree
  const treeResult = await sendCommand(tabId, "Page.getFrameTree", {});
  if (!treeResult.ok) {
    return { ok: false, frames: [], error: treeResult.error || "Page.getFrameTree failed." };
  }

  // Flatten the frame tree into an array using the shared helper
  let frames = [];
  try {
    frames = flattenFrameTree(treeResult.result.frameTree);
  } catch (_error) {
    return { ok: false, frames: [], error: "Failed to parse frame tree result." };
  }

  return { ok: true, frames };
}

// ─── Video Extraction ──────────────────────────────────────────────────────

/**
 * Extract a flat list of all frames in the tree, including nested ones.
 * @param {Object} frameTree - CDP Page.getFrameTree result
 * @param {string} [parentId]
 * @returns {Array<{frameId: string, url: string, parentId?: string}>}
 */
function flattenFrameTree(frameTree, parentId) {
  const frames = [];
  if (!frameTree || !frameTree.frame) return frames;

  const frame = frameTree.frame;
  frames.push({
    frameId: frame.id,
    url: frame.url || "",
    parentId: parentId || frame.parentId || "",
  });

  if (frameTree.childFrames && Array.isArray(frameTree.childFrames)) {
    for (const child of frameTree.childFrames) {
      frames.push(...flattenFrameTree(child, frame.id));
    }
  }

  return frames;
}

/**
 * Evaluate the extraction script in a specific frame context via CDP.
 * Uses the frame's execution context by targeting it via Runtime.evaluate
 * with the appropriate contextId.
 *
 * @param {number} tabId
 * @param {Object} frameInfo - { frameId, url }
 * @param {Object} options
 * @param {number} [options.timeout]
 * @returns {Promise<Array>}
 */
async function evaluateInFrame(tabId, frameInfo, options) {
  const timeout = options.timeout || 15000;
  const script = getExtractionScript();

  const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: false,
    timeout: timeout,
    // Note: contextId is not used here because we rely on the fact that
    // Runtime.evaluate runs in the main world of the target frame by default.
    // For cross-origin iframes, the debugger automatically uses the correct
    // execution context when Page.getFrameTree has identified the frames.
    // We mark the frameId to associate results with the source frame.
  });

  let videos = [];
  if (evaluateResult.ok && evaluateResult.result) {
    try {
      const resultValue = evaluateResult.result;
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
  }

  // Tag each video with frame metadata
  for (const v of videos) {
    v.sourceFrame = frameInfo.frameId;
    v.frameUrl = frameInfo.url || "";
  }

  return videos;
}

/**
 * Extract video sources from a tab using CDP.
 *
 * Flow:
 * 1. Attach CDP to the tab
 * 2. Inject the extraction script via Runtime.evaluate
 * 3. Parse the returned video sources
 * 4. If recursive: discover child frames and extract from each too
 * 5. Optionally detach (or keep attached for future use)
 *
 * @param {number} tabId - The browser tab ID to extract from.
 * @param {Object} [options]
 * @param {boolean} [options.recursive=false] - Whether to recursively search child frames/iframes.
 * @param {number} [options.timeout=15000] - Maximum time to wait for extraction (ms).
 * @param {boolean} [options.detachAfter=true] - Whether to detach CDP after extraction.
 * @returns {Promise<{ok: boolean, videos: Array, error?: string, frames?: Array}>}
 */
async function extractVideosFromTab(tabId, options = {}) {
  const recursive = options.recursive === true;
  const timeout = options.timeout || 15000;
  const detachAfter = options.detachAfter !== false;

  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, videos: [], error: "Invalid tabId: must be a positive integer." };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, videos: [], error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Track all unique videos across all frames
  const allVideos = [];
  const seenUrls = new Set();
  const allFrames = [];

  /**
   * Add video results, deduplicating by URL.
   * @param {Array} videos
   */
  function addVideos(videos) {
    if (!Array.isArray(videos)) return;
    for (const v of videos) {
      if (v && v.url && !seenUrls.has(v.url)) {
        seenUrls.add(v.url);
        allVideos.push(v);
      }
    }
  }

  // Extract from the top-level frame
  const script = getExtractionScript();
  let mainFrameResult;

  if (recursive) {
    // Enable Page domain to get frame tree
    await sendCommand(tabId, "Page.enable", {}).catch(() => {});
    const treeResult = await sendCommand(tabId, "Page.getFrameTree", {});

    if (treeResult.ok && treeResult.result && treeResult.result.frameTree) {
      const frames = flattenFrameTree(treeResult.result.frameTree);

      // Extract from each frame
      for (const frameInfo of frames) {
        // Tag the frame as browsed
        allFrames.push(frameInfo);

        const frameVideos = await evaluateInFrame(tabId, frameInfo, { timeout });
        addVideos(frameVideos);
      }
    } else {
      // Fallback to main frame only if frame tree fails
      mainFrameResult = await sendCommand(tabId, "Runtime.evaluate", {
        expression: script,
        returnByValue: true,
        awaitPromise: false,
        timeout: timeout,
      });

      if (mainFrameResult.ok && mainFrameResult.result) {
        try {
          const resultValue = mainFrameResult.result;
          if (
            resultValue &&
            resultValue.result &&
            resultValue.result.type === "object" &&
            Array.isArray(resultValue.result.value)
          ) {
            addVideos(resultValue.result.value);
          }
        } catch (_error) {}
      }
    }
  } else {
    // Non-recursive: extract from top frame only (original behavior)
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
    try {
      if (
        resultValue &&
        resultValue.result &&
        resultValue.result.type === "object" &&
        Array.isArray(resultValue.result.value)
      ) {
        addVideos(resultValue.result.value);
      }
    } catch (_error) {
      // Malformed result, treat as empty
    }
  }

  if (detachAfter) {
    await detach(tabId);
  }

  const result = { ok: true, videos: allVideos };

  if (recursive && allFrames.length > 0) {
    result.frames = allFrames;
  }

  return result;
}

// ─── Mutation Watching (Layer 2, §2.3) ─────────────────────────────────────

/**
 * Extract videos from a tab while watching for mutations (dynamically-added
 * video elements). Injects a MutationObserver via CDP and waits for videos
 * to appear or until the timeout expires.
 *
 * Strategy:
 * 1. Attach CDP to the tab
 * 2. Inject a script that sets up a MutationObserver on the document
 * 3. The script performs an initial scan and then watches for changes
 * 4. Returns videos as soon as any are found, or after timeout
 *
 * @param {number} tabId - The browser tab ID.
 * @param {Object} [options]
 * @param {number} [options.timeout=10000] - Maximum time to watch for mutations (ms).
 * @param {number} [options.pollInterval=500] - How often to re-scan for videos (ms).
 * @param {boolean} [options.detachAfter=true] - Whether to detach CDP after watching.
 * @returns {Promise<{ok: boolean, videos: Array, timedOut?: boolean, error?: string}>}
 */
async function extractVideosWithMutationWatch(tabId, options = {}) {
  const timeout = options.timeout || 10000;
  const pollInterval = options.pollInterval || 500;
  const detachAfter = options.detachAfter !== false;

  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, videos: [], error: "Invalid tabId: must be a positive integer." };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, videos: [], error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Inject the mutation watch script via Runtime.evaluate
  // The script is async (returns a Promise), so we need awaitPromise: true
  const watchScript = getMutationWatchScript(pollInterval, timeout);

  const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: watchScript,
    returnByValue: true,
    awaitPromise: true,
    timeout: timeout + 2000, // Allow some buffer for script execution
  });

  if (!evaluateResult.ok) {
    if (detachAfter) {
      await detach(tabId);
    }
    return { ok: false, videos: [], error: evaluateResult.error || "Mutation watch script evaluation failed." };
  }

  // Parse the mutation watch result
  let videos = [];
  let timedOut = false;

  try {
    const resultValue = evaluateResult.result;
    if (
      resultValue &&
      resultValue.result &&
      resultValue.result.type === "object" &&
      resultValue.result.value
    ) {
      const value = resultValue.result.value;
      if (Array.isArray(value.videos)) {
        videos = value.videos;
      }
      if (typeof value.timedOut === "boolean") {
        timedOut = value.timedOut;
      }
    }
  } catch (_error) {
    // Malformed result, treat as empty
  }

  if (detachAfter) {
    await detach(tabId);
  }

  return { ok: true, videos, timedOut };
}

// ─── Event Simulation (Layer 2, §2.4) ──────────────────────────────────────

/**
 * Simulate load() and play() events on video elements matching the given URLs.
 * This triggers lazy-loaded players to initialize and start streaming.
 *
 * Some sites (e.g., custom video players) defer loading until the user interacts
 * or the video element explicitly receives a load/play call. By simulating these
 * events via CDP, we force the player to initialize its media pipeline so that
 * subsequent extraction can detect the video sources.
 *
 * @param {number} tabId - The browser tab ID.
 * @param {string[]} [videoUrls] - Array of video URLs to target. If empty or omitted, a no-op is returned.
 * @param {Object} [options]
 * @param {boolean} [options.detachAfter=true] - Whether to detach CDP after simulation.
 * @returns {Promise<{ok: boolean, triggered?: boolean, loadCount?: number, playCount?: number, error?: string}>}
 */
async function simulateVideoEvents(tabId, videoUrls, options = {}) {
  const detachAfter = options.detachAfter !== false;

  if (!tabId || !Number.isInteger(tabId) || tabId <= 0) {
    return { ok: false, triggered: false, error: "Invalid tabId: must be a positive integer." };
  }

  // If no URLs provided, nothing to simulate
  if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0) {
    return { ok: true, triggered: false, loadCount: 0, playCount: 0 };
  }

  // Attach to the tab
  const attachResult = await attach(tabId);
  if (!attachResult.ok) {
    return { ok: false, triggered: false, error: attachResult.error || "Could not attach debugger to tab." };
  }

  // Inject the event simulation script via Runtime.evaluate
  const simulationScript = getEventSimulationScript(videoUrls);

  const evaluateResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: simulationScript,
    returnByValue: true,
    awaitPromise: false,
    timeout: 10000,
  });

  if (!evaluateResult.ok) {
    if (detachAfter) {
      await detach(tabId);
    }
    return { ok: false, triggered: false, error: evaluateResult.error || "Event simulation script evaluation failed." };
  }

  // Parse the simulation result
  let triggered = false;
  let loadCount = 0;
  let playCount = 0;

  try {
    const resultValue = evaluateResult.result;
    if (
      resultValue &&
      resultValue.result &&
      resultValue.result.type === "object" &&
      resultValue.result.value
    ) {
      const value = resultValue.result.value;
      triggered = value.triggered === true;
      loadCount = typeof value.loadCount === "number" ? value.loadCount : 0;
      playCount = typeof value.playCount === "number" ? value.playCount : 0;
    }
  } catch (_error) {
    // Malformed result
  }

  if (detachAfter) {
    await detach(tabId);
  }

  return { ok: true, triggered, loadCount, playCount };
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

export {
  getExtractionScript,
  getMutationWatchScript,
  getEventSimulationScript,
  extractVideosFromTab,
  extractVideosWithMutationWatch,
  simulateVideoEvents,
  discoverFrameTree,
  cleanup,
};
