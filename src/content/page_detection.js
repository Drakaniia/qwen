"use strict";

import { TRANSFER_MODE_RE } from "../shared/media_protocols.js";

const MEDIA_URL_TEXT_RE =
  /(?:(?:https?:)?\\?\/\\?\/|\/)[^"'`<>\s]+(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#][^"'`<>\s]*)?|\.ism(?:\\?\/Manifest)?(?:[?#][^"'`<>\s]*)?)/gi;

/** Match WebSocket streaming URLs (ws://, wss://). */
const WEBSOCKET_URL_RE = /wss?:\/\/[^"'`<>\s]+/gi;

const MUSIC_PLATFORM_SUFFIX_RE =
  /\s*[·•–—|]\s*(?:Spotify|Apple Music|YouTube Music|SoundCloud|Tidal|Deezer|Amazon Music|Pandora|Bandcamp)\s*$/i;

function create(options) {
  const document = options.document;
  const location = options.location;
  const videoFilters = options.videoFilters;
  const seenUrls = options.seenUrls || new Map();

  function toAbsoluteUrl(value) {
    if (!value) {
      return "";
    }
    try {
      return new URL(value, document.baseURI).href;
    } catch (_error) {
      return "";
    }
  }

  function detectFormat(url, mimeType = "") {
    return videoFilters.classifyVideoUrl(url, mimeType);
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeUrlText(value) {
    let text = String(value || "")
      .replace(/\\\//g, "/")
      .replace(/&amp;/gi, "&")
      .replace(/\\u0026/gi, "&")
      .trim();
    text = text.replace(/[),.;]+$/g, "");
    for (let index = 0; index < 2; index += 1) {
      try {
        const decoded = decodeURIComponent(text);
        if (decoded === text) {
          break;
        }
        text = decoded;
      } catch (_error) {
        break;
      }
    }
    return text;
  }

  function titleFromUrl(url) {
    try {
      const parsed = new URL(url);
      const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      return cleanText(file.replace(/\.(mp4|m4v|webm|m3u8|mpd)$/i, "").replace(/[_-]+/g, " "));
    } catch (_error) {
      return "";
    }
  }

  function cleanMusicTitle(value) {
    return cleanText(value).replace(MUSIC_PLATFORM_SUFFIX_RE, "").trim();
  }

  function titleForPage(url) {
    const otherHeadings = [];
    if (typeof document.querySelectorAll === "function") {
      const allHeadings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, figcaption, legend");
      for (const heading of Array.from(allHeadings)) {
        const cleaned = cleanText(heading.textContent);
        if (cleaned) {
          otherHeadings.push(cleaned);
        }
      }
    }

    const pageTitles = [
      cleanText(document.querySelector('meta[property="og:title"]')?.content),
      cleanText(document.querySelector('meta[name="twitter:title"]')?.content),
      cleanText(document.querySelector('meta[property="og:video:title"]')?.content),
      cleanText(document.querySelector('meta[itemprop="name"]')?.content),
      cleanText(document.querySelector('meta[name="title"]')?.content),
      cleanMusicTitle(document.title),
      ...otherHeadings,
    ];

    for (const candidate of pageTitles) {
      if (candidate && !videoFilters.isGenericTitle(candidate)) {
        return candidate;
      }
    }

    return titleFromUrl(url) || "Video";
  }

  function titleForVideo(video, url) {
    if (!video) {
      return titleForPage(url);
    }

    const labelledBy = video.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ? cleanText(
          labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent || "")
            .join(" "),
        )
      : "";

    const videoAriaLabel = cleanText(video.getAttribute("aria-label"));
    const videoTitleAttr = cleanText(video.getAttribute("title"));
    const videoDataTitle = cleanText(video.getAttribute("data-title"));
    const videoDataName = cleanText(video.getAttribute("data-name"));
    const videoAltAttr = cleanText(video.getAttribute("alt"));

    let closestHeadingText = "";
    let current = video;
    while (current) {
      const heading = current.querySelector?.("h1, h2, h3, h4, h5, h6, figcaption, legend");
      if (heading && heading.textContent) {
        const cleaned = cleanText(heading.textContent);
        if (cleaned && !videoFilters.isGenericTitle(cleaned)) {
          closestHeadingText = cleaned;
          break;
        }
      }
      current = current.parentElement || (current.getRootNode && current.getRootNode()?.host);
    }

    const otherHeadings = [];
    if (typeof document.querySelectorAll === "function") {
      const allHeadings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, figcaption, legend");
      for (const heading of Array.from(allHeadings)) {
        const cleaned = cleanText(heading.textContent);
        if (cleaned) {
          otherHeadings.push(cleaned);
        }
      }
    }

    // For music/audio sources, prefer document.title over og:title
    // because music platforms set document.title to "Track · Artist · Platform"
    // while og:title might be "Spotify – Web Player" (generic).
    const isMusicSource =
      videoFilters && videoFilters.isLikelyAudioUrl ? videoFilters.isLikelyAudioUrl(url, "") : false;

    const specificAttrs = [labelledByText, videoAriaLabel, videoTitleAttr, videoDataTitle, videoDataName, videoAltAttr];

    const metadataAttrs = [
      cleanText(document.querySelector('meta[property="og:title"]')?.content),
      cleanText(document.querySelector('meta[name="twitter:title"]')?.content),
      cleanText(document.querySelector('meta[property="og:video:title"]')?.content),
      cleanText(document.querySelector('meta[itemprop="name"]')?.content),
      cleanText(document.querySelector('meta[name="title"]')?.content),
    ];

    let candidates = [];
    if (isMusicSource) {
      candidates = [
        cleanMusicTitle(document.title),
        ...metadataAttrs,
        ...specificAttrs,
        closestHeadingText,
        ...otherHeadings,
        titleFromUrl(url),
      ];
    } else {
      // Priority: video-specific attrs → meta tags → closest heading → document.title → other headings → URL
      // document.title is checked before otherHeadings to prevent generic nav headings
      // ("Related Videos", "Comments") from overriding the actual page title.
      candidates = [
        ...specificAttrs,
        ...metadataAttrs,
        closestHeadingText,
        cleanMusicTitle(document.title),
        ...otherHeadings,
        titleFromUrl(url),
      ];
    }

    for (const candidate of candidates) {
      if (candidate && !videoFilters.isGenericTitle(candidate)) {
        return candidate;
      }
    }

    return "Video";
  }

  function pageThumbnailUrl() {
    return (
      toAbsoluteUrl(document.querySelector('meta[property="og:image"]')?.content) ||
      toAbsoluteUrl(document.querySelector('meta[name="twitter:image"]')?.content) ||
      toAbsoluteUrl(document.querySelector('link[rel~="image_src"]')?.href)
    );
  }

  function thumbnailForVideo(video) {
    const poster = video ? toAbsoluteUrl(video.getAttribute("poster") || video.poster || "") : "";
    return poster || pageThumbnailUrl();
  }

  function videoElementDetails(video) {
    const rect = video.getBoundingClientRect();
    return {
      width: video.videoWidth || rect.width || video.clientWidth || 0,
      height: video.videoHeight || rect.height || video.clientHeight || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      loop: Boolean(video.loop),
      muted: Boolean(video.muted),
      autoplay: Boolean(video.autoplay),
    };
  }

  function buildCandidate(url, source, mimeType = "", video = null) {
    const absoluteUrl = toAbsoluteUrl(url);
    if (!absoluteUrl || videoFilters.isBlockedVideoUrl(absoluteUrl, mimeType)) {
      return null;
    }

    const isWebSocketUrl = absoluteUrl.startsWith("ws://") || absoluteUrl.startsWith("wss://");
    const likelyVideo =
      absoluteUrl.startsWith("blob:") || isWebSocketUrl || videoFilters.isLikelyVideoRequest(absoluteUrl, "media", mimeType);

    if (!likelyVideo) {
      return null;
    }

    const candidate = {
      url: absoluteUrl,
      format: detectFormat(absoluteUrl, mimeType),
      source,
      contentType: mimeType || "",
      pageUrl: location.href,
      frameUrl: location.href,
      title: titleForVideo(video, absoluteUrl),
      thumbnailUrl: thumbnailForVideo(video),
    };

    if (video) {
      Object.assign(candidate, videoElementDetails(video));
    }

    return videoFilters.isLikelyFullLengthVideoCandidate(candidate) ? candidate : null;
  }

  function currentYouTubeVideoPageUrl() {
    if (!videoFilters || typeof videoFilters.normalizeYouTubeVideoPageUrl !== "function") {
      return "";
    }
    return videoFilters.normalizeYouTubeVideoPageUrl(location.href);
  }

  function youtubePageCandidateForVideo(video) {
    const pageUrl = currentYouTubeVideoPageUrl();
    if (!pageUrl || !video) {
      return null;
    }

    const details = videoElementDetails(video);
    if (!videoFilters.isLikelyRealVideoBox(details)) {
      return null;
    }

    const candidate = {
      url: pageUrl,
      format: detectFormat(pageUrl),
      source: "youtube-page",
      contentType: "",
      pageUrl,
      frameUrl: location.href,
      title: titleForVideo(video, pageUrl),
      thumbnailUrl: thumbnailForVideo(video),
      downloadable: true,
      ...details,
    };

    return videoFilters.isLikelyFullLengthVideoCandidate(candidate) ? candidate : null;
  }

  function isLikelyRealPlayer(video) {
    if (!video) {
      return false;
    }

    if (video.srcObject) {
      return false;
    }

    const hostname = location.hostname.toLowerCase();
    if (
      hostname === "meet.google.com" ||
      hostname.endsWith(".zoom.us") ||
      hostname === "zoom.us" ||
      hostname.endsWith(".teams.microsoft.com") ||
      hostname === "teams.microsoft.com" ||
      hostname === "teams.live.com" ||
      hostname.endsWith(".webex.com") ||
      hostname === "webex.com" ||
      hostname.endsWith(".jit.si") ||
      hostname === "meet.jit.si" ||
      hostname.endsWith(".whereby.com") ||
      hostname === "whereby.com"
    ) {
      return false;
    }

    const details = videoElementDetails(video);
    if (details.duration > 0 && details.duration < 30) {
      return false;
    }
    return videoFilters.isLikelyRealVideoBox(details);
  }

  function pageFallbackCandidateForVideo(video) {
    const pageUrl = toAbsoluteUrl(location.href);
    if (!pageUrl || currentYouTubeVideoPageUrl() || !videoFilters.isDownloadableUrl(pageUrl, "")) {
      return null;
    }

    const details = videoElementDetails(video);
    if (!isLikelyRealPlayer(video)) {
      return null;
    }

    const candidate = {
      url: pageUrl,
      format: "PAGE",
      source: "page-fallback",
      contentType: "",
      pageUrl,
      frameUrl: location.href,
      title: titleForVideo(video, pageUrl),
      thumbnailUrl: thumbnailForVideo(video),
      downloadable: true,
      ...details,
    };

    return videoFilters.isLikelyFullLengthVideoCandidate(candidate) ? candidate : null;
  }

  function candidateMetadataSignature(candidate) {
    return [
      candidate.title || "",
      candidate.thumbnailUrl || "",
      candidate.width || "",
      candidate.height || "",
      candidate.duration || "",
      candidate.contentType || "",
    ].join("|");
  }

  function addBuiltCandidate(candidates, candidate) {
    if (!candidate) {
      return null;
    }

    const signature = candidateMetadataSignature(candidate);
    if (seenUrls.get(candidate.url) !== signature) {
      seenUrls.set(candidate.url, signature);
      candidates.push(candidate);
    }

    return candidate;
  }

  function addCandidate(candidates, url, source, mimeType = "", video = null) {
    const candidate = buildCandidate(url, source, mimeType, video);
    return addBuiltCandidate(candidates, candidate);
  }

  function videoHasBlockedMediaSource(video) {
    const sources = [
      { url: video.currentSrc, type: video.type || "" },
      { url: video.src, type: video.type || "" },
    ];
    for (const source of Array.from(video.querySelectorAll("source"))) {
      sources.push({ url: source.src, type: source.type || "" });
    }
    return sources.some((source) => {
      const absoluteUrl = toAbsoluteUrl(source.url);
      return absoluteUrl && videoFilters.isBlockedVideoUrl(absoluteUrl, source.type);
    });
  }

  function videoMetrics(video, candidate) {
    return {
      ...(candidate || {}),
      ...videoElementDetails(video),
    };
  }

  function findOverlayCandidate(video, candidates) {
    return candidates.find((candidate) => videoFilters.isLikelyRealVideoElement(videoMetrics(video, candidate)));
  }

  function scanTextForMediaUrls(text, source) {
    const candidates = [];
    const sourceText = String(text || "");
    if (!sourceText) {
      return candidates;
    }

    for (const match of sourceText.matchAll(MEDIA_URL_TEXT_RE)) {
      const candidateUrl = decodeUrlText(match[0]);
      addCandidate(candidates, candidateUrl, source);
    }

    // Scan for WebSocket streaming URLs (ws://, wss://) used by
    // platforms like Douyu, Huya, and custom players that deliver
    // video frames over WebSocket connections instead of HTTP.
    for (const match of sourceText.matchAll(WEBSOCKET_URL_RE)) {
      const candidateUrl = decodeUrlText(match[0]);
      addCandidate(candidates, candidateUrl, source);
    }

    return candidates;
  }

  /**
   * Scan text for streaming code patterns that indicate the page
   * uses fetch/XHR with transferMode: 'stream' for video delivery.
   *
   * Custom video players often use streaming fetch responses to
   * pipe video data incrementally. Detecting this pattern helps
   * the extension flag the page as a potential streaming video source.
   *
   * @param {string} text - The text to scan (e.g., inline script content)
   * @returns {Array<{type: string, match: string, index: number}>}
   */
  function scanForStreamingPatterns(text) {
    const results = [];
    const sourceText = String(text || "");
    if (!sourceText) {
      return results;
    }

    // Detect transferMode: 'stream' patterns in fetch/XHR code
    let match;
    const re = new RegExp(TRANSFER_MODE_RE.source, TRANSFER_MODE_RE.flags + "g");
    while ((match = re.exec(sourceText)) !== null) {
      results.push({
        type: "transferMode-stream",
        match: match[0],
        index: match.index,
      });
    }

    return results;
  }

  return {
    addBuiltCandidate,
    addCandidate,
    buildCandidate,
    candidateMetadataSignature,
    cleanMusicTitle,
    cleanText,
    currentYouTubeVideoPageUrl,
    decodeUrlText,
    detectFormat,
    findOverlayCandidate,
    isLikelyRealPlayer,
    pageFallbackCandidateForVideo,
    pageThumbnailUrl,
    scanForStreamingPatterns,
    scanTextForMediaUrls,
    thumbnailForVideo,
    titleForVideo,
    titleFromUrl,
    toAbsoluteUrl,
    videoElementDetails,
    videoHasBlockedMediaSource,
    videoMetrics,
    youtubePageCandidateForVideo,
  };
}

export { create };
