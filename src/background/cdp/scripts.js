"use strict";

/**
 * CDP extraction/injection scripts — returned as strings evaluated in page context.
 */

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
      var mediaRe = /https?:\\/\\/[^"' \\n\\r<>]+?\\.(mp4|m3u8|mpd|webm)(?:[?#][^"' \\n\\r<>]*)?/gi;
      var match;
      while ((match = mediaRe.exec(text)) !== null) {
        var url = match[0].replace(/\\\\\\//g, '/');
        addSource(url, '', 'inline-script');
      }
    });
  } catch(e) {}

  // 8. SSR JSON data sources — parse manifest URLs from server-rendered state
  // Targets __NEXT_DATA__, __NUXT__, __INITIAL_STATE__, __PRELOADED_STATE__
  try {
    ssrSources = [];
    // 8a. __NEXT_DATA__ (Next.js)
    var nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl) {
      var nextText = nextDataEl.textContent || '';
      if (nextText.length > 0 && nextText.length < 5242880) {
        try {
          var nextData = JSON.parse(nextText);
          ssrSources.push({ source: '__NEXT_DATA__', data: nextData });
        } catch(e) {}
      }
    }
    // 8b. __NUXT__ (Nuxt.js)
    var nuxtEl = document.getElementById('__NUXT__');
    if (nuxtEl) {
      var nuxtText = nuxtEl.textContent || '';
      if (nuxtText.length > 0 && nuxtText.length < 5242880) {
        try {
          var nuxtData = JSON.parse(nuxtText);
          ssrSources.push({ source: '__NUXT__', data: nuxtData });
        } catch(e) {}
      }
    }
    // 8c. Window globals (accessed via CDP evaluate which runs in page context)
    if (typeof window.__INITIAL_STATE__ !== 'undefined') {
      ssrSources.push({ source: '__INITIAL_STATE__', data: window.__INITIAL_STATE__ });
    }
    if (typeof window.__PRELOADED_STATE__ !== 'undefined') {
      ssrSources.push({ source: '__PRELOADED_STATE__', data: window.__PRELOADED_STATE__ });
    }
    // Walk all SSR sources for HLS URLs
    for (var si = 0; si < ssrSources.length; si++) {
      walkSsrJson(ssrSources[si].data, results, addSource, urls, ssrSources[si].source);
    }
  } catch(e) {}

  return results;

  // Walk SSR JSON recursively to find .m3u8 URLs
  function walkSsrJson(obj, results, addSource, urls, sourceName) {
    if (!obj || typeof obj !== 'object') return;
    var seen = new WeakSet();
    var queue = [{ val: obj, path: 'root' }];
    while (queue.length) {
      var item = queue.shift();
      if (!item.val || typeof item.val !== 'object') continue;
      try { if (seen.has(item.val)) continue; seen.add(item.val); } catch(e) { continue; }
      for (var key in item.val) {
        if (!Object.prototype.hasOwnProperty.call(item.val, key)) continue;
        try {
          var val = item.val[key];
          var path = item.path + '.' + key;
          if (typeof val === 'string' && val.length > 5 && val.length < 2000) {
            if (/\.m3u8($|\?)/i.test(val)) {
              addSource(val, '', 'ssr-json:' + sourceName + ':' + path);
            }
          } else if (typeof val === 'object' && val !== null) {
            queue.push({ val: val, path: path });
          }
        } catch(e) {}
      }
    }
  }

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
            if (/^(https?:)?\\/\\/[^"' \\n\\r<>]+?\\.(mp4|m3u8|mpd|webm)([?#]|$)/i.test(val)) {
              var cleanUrl = val.replace(/\\\\\\//g, '/');
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

export { getExtractionScript, getMutationWatchScript, getEventSimulationScript };
