"use strict";

const MEDIA_URL_TEXT_RE =
  /(?:(?:https?:)?\\?\/\\?\/|\/)[^"'`<>\s]+(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#][^"'`<>\s]*)?|\.ism(?:\\?\/Manifest)?(?:[?#][^"'`<>\s]*)?)/gi;

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
    const pageTitles = [
      cleanText(document.querySelector('meta[property="og:title"]')?.content),
      cleanText(document.querySelector('meta[name="twitter:title"]')?.content),
      cleanText(document.querySelector('meta[property="og:video:title"]')?.content),
      cleanText(document.querySelector('meta[itemprop="name"]')?.content),
      cleanText(document.querySelector('meta[name="title"]')?.content),
      cleanText(document.querySelector("h1")?.textContent),
      cleanMusicTitle(document.title),
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

    // For music/audio sources, prefer document.title over og:title
    // because music platforms set document.title to "Track · Artist · Platform"
    // while og:title might be "Spotify – Web Player" (generic).
    const isMusicSource =
      videoFilters && videoFilters.isLikelyAudioUrl ? videoFilters.isLikelyAudioUrl(url, "") : false;

    const candidates = isMusicSource
      ? [
          cleanMusicTitle(document.title),
          cleanText(document.querySelector('meta[property="og:title"]')?.content),
          cleanText(document.querySelector('meta[name="twitter:title"]')?.content),
          cleanText(document.querySelector('meta[property="og:video:title"]')?.content),
          cleanText(document.querySelector('meta[itemprop="name"]')?.content),
          cleanText(document.querySelector('meta[name="title"]')?.content),
          cleanText(document.querySelector("h1")?.textContent),
          labelledByText,
          videoAriaLabel,
          videoTitleAttr,
          titleFromUrl(url),
        ]
      : [
          cleanText(document.querySelector('meta[property="og:title"]')?.content),
          cleanText(document.querySelector('meta[name="twitter:title"]')?.content),
          cleanText(document.querySelector('meta[property="og:video:title"]')?.content),
          cleanText(document.querySelector('meta[itemprop="name"]')?.content),
          cleanText(document.querySelector('meta[name="title"]')?.content),
          cleanText(document.querySelector("h1")?.textContent),
          cleanMusicTitle(document.title),
          labelledByText,
          videoAriaLabel,
          videoTitleAttr,
          titleFromUrl(url),
        ];

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
    const thumbnail = poster || pageThumbnailUrl();
    if (/\.(?:gif|gifv)(?:$|[?#])/i.test(thumbnail)) {
      return "";
    }
    return thumbnail;
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

    const likelyVideo =
      absoluteUrl.startsWith("blob:") || videoFilters.isLikelyVideoRequest(absoluteUrl, "media", mimeType);

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
      ...videoElementDetails(video),
      url: candidate.url,
      contentType: candidate.contentType || "",
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
    return candidates;
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
