import type { DownloadFallbackDeps, NativeCandidate, TabId, VideoInput, VideoRecord } from "./types.js";

const HARD_ACCESS_ERROR_RE =
  /\bHTTP Error\s+(?:401|403|404|410|451)\b|\b(?:Unauthorized|Forbidden|Gone|Not Found|Unavailable For Legal Reasons)\b|Invalid data found when processing input/i;
const RETRYABLE_SOURCE_ERROR_RE =
  /Unsupported URL|did not find any downloadable video formats|No video formats|Requested format is not available|Invalid data found when processing input|HTTP Error 5\d{2}|ConnectionResetError|TransportError|RemoteDisconnected|Connection aborted|connection.*reset/i;

function isHardAccessError(error: unknown): boolean {
  return HARD_ACCESS_ERROR_RE.test(String(error || ""));
}

function isRetryableSourceError(error: unknown): boolean {
  const text = String(error || "");
  return isHardAccessError(text) || RETRYABLE_SOURCE_ERROR_RE.test(text);
}

// ── User-facing error mappings (spec D4) ──────────────────────────────────
//
// The if/else chain this replaces was the last hardcoded dispatch table in the
// download path. `Map` insertion order *is* the precedence order — the first
// mapping whose `pattern` matches wins — so the specific `http-500` case stays
// ahead of the general `http-5xx` one exactly as the chain had it.
//
// The keys are stable codes rather than array positions so a mapping is identified by
// name, not by its position in the list. Adding a mapping is one `ERROR_MAPPINGS`
// entry; no control flow is edited.
//
// Module-private on purpose: `userFriendlyDownloadError` is the only way the rest of
// the background reaches a mapping, and AGENTS.md forbids exports without a caller or
// a test. Expose it if a test ever needs to enumerate the registry.

/** One mapping: a stable code, the pattern that selects it, and the message to show. */
interface ErrorMapping {
  /** Matches against the whole trimmed error text. */
  pattern: RegExp;
  /** Builds the user-facing sentence. Only called for the winning mapping. */
  message: (text: string) => string;
}

const ERROR_MAPPINGS = new Map<string, ErrorMapping>([
  [
    // HTTP 500 / Internal Server Error — the site's server is down or misconfigured
    "http-500",
    {
      pattern: /HTTP Error 500|Internal Server Error|HTTPError 500/i,
      message: (text) => {
        const siteMatch = text.match(/\[([^\]]+)\]/);
        const sitePrefix = siteMatch ? `${siteMatch[1]} returned` : "The video server returned";
        return (
          `${sitePrefix} a server error (HTTP 500). ` +
          "The website is experiencing internal server problems and cannot serve this video right now."
        );
      },
    },
  ],
  [
    // HTTP 5xx (other server errors)
    "http-5xx",
    {
      pattern: /HTTP Error 5\d{2}|HTTPError 5\d{2}/i,
      message: (text) => {
        const codeMatch = text.match(/HTTP Error (5\d{2})|HTTPError (5\d{2})/i);
        const code = codeMatch ? codeMatch[1] || codeMatch[2] : "5xx";
        return `The video server returned an HTTP ${code} server error. The site may be temporarily unavailable or overloaded.`;
      },
    },
  ],
  [
    // DRM. Nothing downstream can fix this, so it must not read like a transient
    // failure the user should retry — and it has to be matched before the generic
    // "no formats" mapping below, which yt-dlp also raises for DRM'd media.
    "drm",
    {
      pattern: /\bDRM\b|Widevine|PlayReady|protected content|encrypted media/i,
      message: () =>
        "This stream is DRM-protected (Widevine / PlayReady). The browser only decrypts it " +
        "for playback, so no downloader can copy it.",
    },
  ],
  [
    // "Unsupported URL" is yt-dlp's words for "I have no extractor for this address" —
    // the shape of the message the extension used to show verbatim under a dead row.
    // Namely: the URL is a page, not a media file, and the stream is loaded by the
    // player's own JavaScript.
    "unsupported-url",
    {
      pattern: /Unsupported URL|no suitable extractor|is not a valid URL|Unable to extract/i,
      message: () =>
        "This page does not expose a downloadable video link — the player loads the stream " +
        "itself. Start playing the video so the stream loads, then reopen this popup.",
    },
  ],
  [
    // The helper reached the URL but found nothing it could hand to a downloader.
    "no-formats",
    {
      pattern:
        /did not find any downloadable video formats|No video formats|no formats found|Requested format is not available/i,
      message: () =>
        "The helper reached that address but found no downloadable video in it. It may be a " +
        "player page or a video segment rather than a media file.",
    },
  ],
  [
    // aria2c unknown option errors — config/compatibility issue, not network
    "aria2c-config",
    {
      pattern: /aria2c.*unknown option/i,
      message: () => "The download helper has an invalid configuration option. Please report this as a bug.",
    },
  ],
  [
    // Connection / timeout / transport errors
    "connection",
    {
      pattern:
        /timed? out|timeout|ConnectionError|connection.*refused|no route to host|ConnectionResetError|TransportError|RemoteDisconnect|connection.*reset|10054/i,
      message: () =>
        "Could not connect to the video server. The site may be down, blocking the request, or your network may be unstable.",
    },
  ],
]);

function userFriendlyDownloadError(error: unknown): string {
  const text = String(error || "").trim();
  if (!text) {
    return "";
  }

  for (const mapping of ERROR_MAPPINGS.values()) {
    if (mapping.pattern.test(text)) {
      return mapping.message(text);
    }
  }

  return "";
}

function exhaustedSourcesError(error: unknown, attemptedUrls: Set<string> | undefined): string {
  const count = attemptedUrls && attemptedUrls.size ? attemptedUrls.size : 1;
  const details = String(error || "The helper could not download this source.").trim();
  const friendly = userFriendlyDownloadError(details);
  const prefix = friendly ? `${friendly}\n\nTechnical details: ` : "";
  return count > 1 ? `${prefix}${details}\nTried ${count} sources.` : `${prefix}${details}`;
}

function downloadableVariants(
  video: VideoRecord,
  attemptedUrls: Set<string>,
  deps: DownloadFallbackDeps,
): VideoRecord[] {
  const variants = [
    ...deps.variantsForVideo(video),
    ...(Array.isArray(video?.groupVariants) ? video.groupVariants : []),
  ];
  const seenUrls = new Set<string>();
  const result: VideoRecord[] = [];

  for (const variant of variants) {
    const url = deps.normalizeUrl(variant?.url || "");
    if (!url || seenUrls.has(url) || attemptedUrls.has(url) || !variant.downloadable) {
      continue;
    }
    // Skip blob:, data:, and file: URLs - they cannot be sent to yt-dlp
    if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("file:")) {
      continue;
    }
    seenUrls.add(url);
    result.push(variant);
  }

  return result;
}

function isExtractorPageVideo(video: Pick<VideoRecord, "source" | "format">): boolean {
  const format = String(video?.format || "").toUpperCase();
  return (
    video?.source === "manual-url" || video?.source === "youtube-page" || format === "PAGE" || format === "YOUTUBE"
  );
}

function pageFallbackVideoForSource(
  video: VideoRecord,
  attemptedUrls: Set<string>,
  deps: DownloadFallbackDeps,
): VideoRecord | null {
  const pageUrl = deps.normalizeUrl(video?.pageUrl || video?.frameUrl || "");
  const sourceUrl = deps.normalizeUrl(video?.url || "");
  if (!pageUrl || pageUrl === sourceUrl || attemptedUrls.has(pageUrl) || !deps.isDownloadableUrl(pageUrl, "")) {
    return null;
  }

  return {
    ...video,
    id: deps.hashId(pageUrl),
    url: pageUrl,
    format: "PAGE",
    source: "page-fallback",
    contentType: "",
    pageUrl,
    requestHeaders: [],
    downloadable: true,
    sizeBytes: null,
  };
}

function resolverUrlsForSource(sourceVideo: VideoRecord, deps: DownloadFallbackDeps): string[] {
  const urls = [sourceVideo?.pageUrl || "", sourceVideo?.frameUrl || "", sourceVideo?.url || ""];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of urls) {
    const url = deps.normalizeUrl(value);
    if (!url || seen.has(url) || !deps.isDownloadableUrl(url, "")) {
      continue;
    }
    seen.add(url);
    result.push(url);
  }

  return result;
}

async function resolveMediaCandidatesForSource(
  tabId: TabId,
  sourceVideo: VideoRecord,
  attemptedUrls: Set<string>,
  deps: DownloadFallbackDeps,
): Promise<VideoRecord[]> {
  const resolverUrls = resolverUrlsForSource(sourceVideo, deps);
  if (!resolverUrls.length) {
    return [];
  }

  const rawCandidates: NativeCandidate[] = [];
  let title = "";
  for (const url of resolverUrls) {
    const requestId = `resolve_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      const response = await deps.nativeRequest(
        {
          type: "resolveMediaCandidates",
          id: requestId,
          url,
          pageUrl: sourceVideo.pageUrl || sourceVideo.frameUrl || "",
          userAgent: deps.userAgent,
          requestHeaders: await deps.nativeRequestHeadersForVideo(
            url,
            sourceVideo.pageUrl || sourceVideo.frameUrl || "",
          ),
        },
        20000,
      );
      title = title || response?.title || "";
      rawCandidates.push(...(Array.isArray(response?.candidates) ? response.candidates : []));
    } catch (_error) {
      // Some media URLs are binary or server-blocked. Keep inspecting the page/frame fallbacks.
    }
  }

  if (!rawCandidates.length) {
    return [];
  }

  const candidates: VideoRecord[] = [];
  const seenCandidateUrls = new Set<string>();
  for (const candidate of rawCandidates) {
    const candidateUrl = deps.normalizeUrl(candidate?.url || "");
    if (
      !candidateUrl ||
      seenCandidateUrls.has(candidateUrl) ||
      attemptedUrls.has(candidateUrl) ||
      !deps.isDownloadableUrl(candidateUrl, candidate?.contentType || "")
    ) {
      continue;
    }
    seenCandidateUrls.add(candidateUrl);
    const detectedInput: VideoInput = {
      url: candidate.url,
      format: candidate.format || deps.detectFormat(candidate.url || "", candidate.contentType || ""),
      source: candidate.source || "resolved-page",
      contentType: candidate.contentType || "",
      title: candidate.title || title || sourceVideo.title || deps.titleFromUrl(candidate.url || ""),
      pageUrl: sourceVideo.pageUrl || sourceVideo.url || "",
      frameUrl: sourceVideo.frameUrl || sourceVideo.pageUrl || "",
      downloadable: true,
      duration: sourceVideo.duration || null,
      width: sourceVideo.width || null,
      height: sourceVideo.height || null,
      bitrate: candidate.bitrate || null,
      thumbnailUrl: sourceVideo.thumbnailUrl || "",
    };
    const detected = await deps.addDetectedVideo(tabId, detectedInput);
    candidates.push({
      ...(detected || candidate),
      url: candidate.url,
      id: detected?.id || candidate.id || deps.hashId(candidate.url || ""),
      format:
        candidate.format || detected?.format || deps.detectFormat(candidate.url || "", candidate.contentType || ""),
      source: candidate.source || detected?.source || "resolved-page",
      title: detected?.title || candidate.title || title || sourceVideo.title || deps.titleFromUrl(candidate.url || ""),
      pageUrl: sourceVideo.pageUrl || sourceVideo.url || "",
      frameUrl: sourceVideo.frameUrl || sourceVideo.pageUrl || "",
      contentType: candidate.contentType || detected?.contentType || "",
      downloadable: true,
      sizeBytes: detected?.sizeBytes || null,
      backend: "auto",
      fallbackReason: "resolved-media-candidate",
      confidence: Number(candidate.confidence || 0),
    });
  }

  return candidates.sort((left, right) => Number(right.confidence || 0) - Number(left.confidence || 0));
}

/**
 * Check if a video candidate is an iframe-page source that should trigger
 * a fallback search for the actual video URL from inside the iframe.
 */
function isIframePageVideo(video: Pick<VideoRecord, "source" | "format">): boolean {
  return video?.source === "iframe-page" && String(video?.format || "").toUpperCase() === "PAGE";
}

/**
 * Look for videos detected by the content script inside an iframe.
 * These have their frameUrl set to the iframe's src URL.
 */
function findIframeDetectedVideo(
  iframeUrl: string | undefined,
  tabVideos: VideoRecord[] | undefined,
): VideoRecord | null {
  if (!iframeUrl || !Array.isArray(tabVideos) || !tabVideos.length) {
    return null;
  }

  const normalizedIframe = iframeUrl
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");

  const iframeVideos = tabVideos.filter((v) => {
    if (!v || v.source === "iframe-page") return false;
    if (!v.frameUrl) return false;
    const vFrameUrl = v.frameUrl
      .toLowerCase()
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
    if (vFrameUrl !== normalizedIframe) return false;
    // Accept any downloadable format — even catch-all VIDEO (used by nextflicks-style
    // sites) is better than the PAGE candidate that already failed.
    const format = String(v.format || "").toUpperCase();
    return format !== "PAGE" && v.downloadable !== false;
  });

  if (!iframeVideos.length) {
    return null;
  }

  // Sort by quality (height then bitrate), return best match
  iframeVideos.sort((a, b) => {
    const aScore = (a.height || 0) * 1000 + (a.bitrate || a.tbr || 0);
    const bScore = (b.height || 0) * 1000 + (b.bitrate || b.tbr || 0);
    return bScore - aScore;
  });

  return iframeVideos[0];
}

async function fallbackVideoForDownload(
  tabId: TabId,
  failedVideo: VideoRecord,
  attemptedUrls: Set<string>,
  deps: DownloadFallbackDeps,
): Promise<VideoRecord | null> {
  const groupedVideo = deps.findGroupedVideoForAnyVariant(tabId, failedVideo) || failedVideo;
  const variants = downloadableVariants(groupedVideo, attemptedUrls, deps);
  const fallback = variants[0];
  if (fallback) {
    return {
      ...fallback,
      groupId: groupedVideo.id || failedVideo.groupId || failedVideo.id,
      groupVariants: deps.variantsForVideo(groupedVideo),
    };
  }

  // Iframe-specific fallback: look for actual video URL detected inside the iframe
  if (isIframePageVideo(failedVideo) && deps.getVisibleVideosForTab) {
    const tabVideos = deps.getVisibleVideosForTab(tabId);
    const iframeFallback = findIframeDetectedVideo(failedVideo.url, tabVideos);
    if (iframeFallback) {
      const normalizedUrl = deps.normalizeUrl(iframeFallback.url || "");
      if (normalizedUrl && !attemptedUrls.has(normalizedUrl) && iframeFallback.downloadable !== false) {
        return {
          ...iframeFallback,
          id: deps.hashId(normalizedUrl),
          groupId: groupedVideo.id || failedVideo.groupId || failedVideo.id,
          groupVariants: deps.variantsForVideo(groupedVideo),
          fallbackReason: "iframe-detected-video",
        };
      }
    }
  }

  const pageFallback = pageFallbackVideoForSource(failedVideo, attemptedUrls, deps);
  if (pageFallback) {
    return {
      ...pageFallback,
      groupId: groupedVideo.id || failedVideo.groupId || failedVideo.id,
      groupVariants: deps.variantsForVideo(groupedVideo),
    };
  }

  const resolvedCandidates = await resolveMediaCandidatesForSource(tabId, failedVideo, attemptedUrls, deps);
  if (resolvedCandidates.length) {
    return {
      ...resolvedCandidates[0],
      groupId: groupedVideo.id || failedVideo.groupId || failedVideo.id,
      groupVariants: deps.variantsForVideo(groupedVideo),
    };
  }

  return null;
}

export {
  downloadableVariants,
  exhaustedSourcesError,
  fallbackVideoForDownload,
  isExtractorPageVideo,
  isHardAccessError,
  isRetryableSourceError,
  pageFallbackVideoForSource,
  resolveMediaCandidatesForSource,
  userFriendlyDownloadError,
};
