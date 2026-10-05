import type { DetectedVideo } from "../shared/contracts.js";
import { THUMBNAIL_CANDIDATE_LIMIT, dedupeThumbnailUrls, deriveSiteThumbnail } from "../ui/thumbnail_sources.js";
import { captureFrame } from "./frame_capture.js";

/**
 * The `shared/video_filters.js` surface this module uses. It is injected rather than
 * imported so the detection logic stays testable against a stub, and so the check stays
 * honest about which helpers it actually depends on.
 *
 * `isLikelyAudioUrl` is probed for below but is not exported by `video_filters` today,
 * so the optional member is what makes that defensive probe typecheck instead of
 * pretending the helper exists.
 */
type VideoFilters = typeof import("../shared/video_filters.js") & {
  isLikelyAudioUrl?: (url: string, contentType: string) => boolean;
};

const MEDIA_URL_TEXT_RE =
  /(?:(?:https?:)?\\?\/\\?\/|\/)[^"'`<>\s]+(?:\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#][^"'`<>\s]*)?|\.ism(?:\\?\/Manifest)?(?:[?#][^"'`<>\s]*)?)/gi;

/** Match WebSocket streaming URLs (ws://, wss://). */
const WEBSOCKET_URL_RE = /wss?:\/\/[^"'`<>\s]+/gi;

const MUSIC_PLATFORM_SUFFIX_RE =
  /\s*[·•–—|]\s*(?:Spotify|Apple Music|YouTube Music|SoundCloud|Tidal|Deezer|Amazon Music|Pandora|Bandcamp)\s*$/i;

/** A discovered video, before `background/addDetectedVideo` stamps it with an `id`. */
export interface VideoCandidate extends Omit<DetectedVideo, "id"> {
  url: string;
  format: string;
  source: string;
  contentType: string;
  pageUrl: string;
  frameUrl: string;
  title: string;
  thumbnailUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  loop?: boolean;
  muted?: boolean;
  autoplay?: boolean;
  /** Lowercased Content-Type a background-proxy `HEAD` confirmed as media. */
  proxyContentType?: string;
}

/** The measurable box + playback flags every real-player test reads. */
interface VideoElementDetails {
  width: number;
  height: number;
  duration: number;
  loop: boolean;
  muted: boolean;
  autoplay: boolean;
}

export interface PageDetectionOptions {
  document: Document;
  location: Location;
  videoFilters: VideoFilters;
  /** url → metadata signature; a repeat whose signature changed is re-emitted. */
  seenUrls?: Map<string, string>;
  /** Per-scan tally, owned by the caller so resetting is one assignment. */
  scanStats?: { discovered: number };
}

function create(options: PageDetectionOptions) {
  const { document, location, videoFilters } = options;
  const seenUrls = options.seenUrls || new Map<string, string>();
  /**
   * Per-scan tally for the Phase 8 candidate-count instrumentation (spec D12).
   *
   * `discovered` is bumped once per candidate the six scanners hand over, *before*
   * the `seenUrls` collapse — so it counts discoveries, not distinct URLs, which is
   * what makes the ratio against `videos.length` in `content.ts` meaningful. Owned by
   * the caller (which resets it per scan) and passed in the same way as `seenUrls`,
   * rather than exposed as a getter, so resetting is one assignment at the scan site.
   */
  const scanStats = options.scanStats || { discovered: 0 };

  /** `content` lives on `HTMLMetaElement`, not on the `Element` `querySelector` returns. */
  function metaContent(selector: string): string {
    return document.querySelector<HTMLMetaElement>(selector)?.content || "";
  }

  function toAbsoluteUrl(value: string | null | undefined): string {
    if (!value) {
      return "";
    }
    try {
      return new URL(value, document.baseURI).href;
    } catch (_error) {
      return "";
    }
  }

  function detectFormat(url: string, mimeType = ""): string {
    return videoFilters.classifyVideoUrl(url, mimeType);
  }

  function cleanText(value: string | null | undefined): string {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeUrlText(value: string | null | undefined): string {
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

  function titleFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const file = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      return cleanText(file.replace(/\.(mp4|m4v|webm|m3u8|mpd)$/i, "").replace(/[_-]+/g, " "));
    } catch (_error) {
      return "";
    }
  }

  function cleanMusicTitle(value: string | null | undefined): string {
    return cleanText(value).replace(MUSIC_PLATFORM_SUFFIX_RE, "").trim();
  }

  /** Every non-empty heading on the page — the last-resort title pool. */
  function otherHeadings(): string[] {
    const headings: string[] = [];
    if (typeof document.querySelectorAll === "function") {
      const allHeadings = document.querySelectorAll("h1, h2, h3, h4, h5, h6, figcaption, legend");
      for (const heading of Array.from(allHeadings)) {
        const cleaned = cleanText(heading.textContent);
        if (cleaned) {
          headings.push(cleaned);
        }
      }
    }
    return headings;
  }

  /** `og:title` → `twitter:title` → … in the order the popup sorts by specificity. */
  function metadataTitles(): string[] {
    return [
      cleanText(metaContent('meta[property="og:title"]')),
      cleanText(metaContent('meta[name="twitter:title"]')),
      cleanText(metaContent('meta[property="og:video:title"]')),
      cleanText(metaContent('meta[itemprop="name"]')),
      cleanText(metaContent('meta[name="title"]')),
    ];
  }

  function titleForPage(url: string): string {
    const pageTitles = [...metadataTitles(), cleanMusicTitle(document.title), ...otherHeadings()];

    for (const candidate of pageTitles) {
      if (candidate && !videoFilters.isGenericTitle(candidate)) {
        return candidate;
      }
    }

    return titleFromUrl(url) || "Video";
  }

  function titleForVideo(video: HTMLVideoElement | null, url: string): string {
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
    // The heading can live in the shadow root that hosts the player, so walk out of the
    // video through parents and through shadow hosts until one turns up.
    let current: Element | null = video;
    while (current) {
      const heading = current.querySelector("h1, h2, h3, h4, h5, h6, figcaption, legend");
      if (heading && heading.textContent) {
        const cleaned = cleanText(heading.textContent);
        if (cleaned && !videoFilters.isGenericTitle(cleaned)) {
          closestHeadingText = cleaned;
          break;
        }
      }
      const root = current.getRootNode();
      current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }

    const headings = otherHeadings();

    // For music/audio sources, prefer document.title over og:title
    // because music platforms set document.title to "Track · Artist · Platform"
    // while og:title might be "Spotify – Web Player" (generic).
    const isMusicSource = videoFilters.isLikelyAudioUrl ? videoFilters.isLikelyAudioUrl(url, "") : false;

    const specificAttrs = [labelledByText, videoAriaLabel, videoTitleAttr, videoDataTitle, videoDataName, videoAltAttr];
    const metadataAttrs = metadataTitles();

    let candidates: string[];
    if (isMusicSource) {
      candidates = [
        cleanMusicTitle(document.title),
        ...metadataAttrs,
        ...specificAttrs,
        closestHeadingText,
        ...headings,
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
        ...headings,
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

  function pageThumbnailUrl(): string {
    return (
      toAbsoluteUrl(metaContent('meta[property="og:image"]')) ||
      toAbsoluteUrl(metaContent('meta[name="twitter:image"]')) ||
      toAbsoluteUrl(document.querySelector<HTMLLinkElement>('link[rel~="image_src"]')?.href)
    );
  }

  /**
   * The row's thumbnail ladder (spec §3, D12): **poster → captured frame → site-derived
   * art → page metadata**, deduped and capped at `THUMBNAIL_CANDIDATE_LIMIT`.
   *
   * Video-specific art first, page metadata last — the inverse of the old
   * `poster || og:image`, which painted the same hero image into every row of a page
   * with a dozen preview streams. The capture sits above the derived URL because it is
   * both more specific (this element, not this host) and already in memory, so it
   * costs no request (D12a). `captureFrame` is deduped per element, so calling it for
   * every scanner's hand-over of the same `<video>` draws once per page.
   */
  function thumbnailCandidatesForVideo(video: HTMLVideoElement | null): string[] {
    const poster = video ? toAbsoluteUrl(video.getAttribute("poster") || video.poster || "") : "";
    return dedupeThumbnailUrls([
      poster,
      video ? captureFrame(video) : "",
      deriveSiteThumbnail(location.href),
      pageThumbnailUrl(),
    ]).slice(0, THUMBNAIL_CANDIDATE_LIMIT);
  }

  function thumbnailForVideo(video: HTMLVideoElement | null): string {
    return thumbnailCandidatesForVideo(video)[0] || "";
  }

  function videoElementDetails(video: HTMLVideoElement): VideoElementDetails {
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

  function buildCandidate(
    url: string,
    source: string,
    mimeType = "",
    video: HTMLVideoElement | null = null,
  ): VideoCandidate | null {
    const absoluteUrl = toAbsoluteUrl(url);
    if (!absoluteUrl || videoFilters.isBlockedVideoUrl(absoluteUrl, mimeType)) {
      return null;
    }

    const isWebSocketUrl = absoluteUrl.startsWith("ws://") || absoluteUrl.startsWith("wss://");
    const likelyVideo =
      absoluteUrl.startsWith("blob:") ||
      isWebSocketUrl ||
      videoFilters.isLikelyVideoRequest(absoluteUrl, "media", mimeType);

    if (!likelyVideo) {
      return null;
    }

    const thumbnailCandidates = thumbnailCandidatesForVideo(video);
    const candidate: VideoCandidate = {
      url: absoluteUrl,
      format: detectFormat(absoluteUrl, mimeType),
      source,
      contentType: mimeType || "",
      pageUrl: location.href,
      frameUrl: location.href,
      title: titleForVideo(video, absoluteUrl),
      thumbnailUrl: thumbnailCandidates[0] || "",
      thumbnailCandidates,
    };

    if (video) {
      Object.assign(candidate, videoElementDetails(video));
    }

    return videoFilters.isLikelyFullLengthVideoCandidate(candidate) ? candidate : null;
  }

  function currentYouTubeVideoPageUrl(): string {
    if (!videoFilters || typeof videoFilters.normalizeYouTubeVideoPageUrl !== "function") {
      return "";
    }
    return videoFilters.normalizeYouTubeVideoPageUrl(location.href);
  }

  function youtubePageCandidateForVideo(video: HTMLVideoElement): VideoCandidate | null {
    const pageUrl = currentYouTubeVideoPageUrl();
    if (!pageUrl || !video) {
      return null;
    }

    const details = videoElementDetails(video);
    if (!videoFilters.isLikelyRealVideoBox(details)) {
      return null;
    }

    const thumbnailCandidates = thumbnailCandidatesForVideo(video);
    const candidate: VideoCandidate = {
      url: pageUrl,
      format: detectFormat(pageUrl),
      source: "youtube-page",
      contentType: "",
      pageUrl,
      frameUrl: location.href,
      title: titleForVideo(video, pageUrl),
      thumbnailUrl: thumbnailCandidates[0] || "",
      thumbnailCandidates,
      downloadable: true,
      ...details,
    };

    return videoFilters.isLikelyFullLengthVideoCandidate(candidate) ? candidate : null;
  }

  function isLikelyRealPlayer(video: HTMLVideoElement | null): boolean {
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

  function pageFallbackCandidateForVideo(video: HTMLVideoElement): VideoCandidate | null {
    const pageUrl = toAbsoluteUrl(location.href);
    if (!pageUrl || currentYouTubeVideoPageUrl() || !videoFilters.isDownloadableUrl(pageUrl, "")) {
      return null;
    }

    const details = videoElementDetails(video);
    if (!isLikelyRealPlayer(video)) {
      return null;
    }

    const thumbnailCandidates = thumbnailCandidatesForVideo(video);
    const candidate: VideoCandidate = {
      url: pageUrl,
      format: "PAGE",
      source: "page-fallback",
      contentType: "",
      pageUrl,
      frameUrl: location.href,
      title: titleForVideo(video, pageUrl),
      thumbnailUrl: thumbnailCandidates[0] || "",
      thumbnailCandidates,
      downloadable: true,
      ...details,
    };

    return videoFilters.isLikelyFullLengthVideoCandidate(candidate) ? candidate : null;
  }

  function candidateMetadataSignature(candidate: VideoCandidate): string {
    return [
      candidate.title || "",
      candidate.thumbnailUrl || "",
      // The whole ladder, not just its head: a frame that only becomes capturable on a
      // later scan must re-emit the candidate, or the row keeps the poster it already
      // failed on and never reaches the capture (spec §3/§5).
      candidate.thumbnailCandidates?.join("|") || "",
      candidate.width || "",
      candidate.height || "",
      candidate.duration || "",
      candidate.contentType || "",
    ].join("|");
  }

  function addBuiltCandidate(candidates: VideoCandidate[], candidate: VideoCandidate | null): VideoCandidate | null {
    if (!candidate) {
      return null;
    }

    scanStats.discovered += 1;
    const signature = candidateMetadataSignature(candidate);
    if (seenUrls.get(candidate.url) !== signature) {
      seenUrls.set(candidate.url, signature);
      candidates.push(candidate);
    }

    return candidate;
  }

  function addCandidate(
    candidates: VideoCandidate[],
    url: string,
    source: string,
    mimeType = "",
    video: HTMLVideoElement | null = null,
  ): VideoCandidate | null {
    const candidate = buildCandidate(url, source, mimeType, video);
    return addBuiltCandidate(candidates, candidate);
  }

  function videoHasBlockedMediaSource(video: HTMLVideoElement): boolean {
    // `<video>` carries no `type` attribute in the DOM IDL — only `<source>` does — so
    // the two element-level entries are always classified on their URL alone.
    const sources = [
      { url: video.currentSrc, type: "" },
      { url: video.src, type: "" },
    ];
    for (const source of Array.from(video.querySelectorAll("source"))) {
      sources.push({ url: source.src, type: source.type || "" });
    }
    return sources.some((source) => {
      const absoluteUrl = toAbsoluteUrl(source.url);
      return absoluteUrl && videoFilters.isBlockedVideoUrl(absoluteUrl, source.type);
    });
  }

  function videoMetrics(
    video: HTMLVideoElement,
    candidate?: VideoCandidate | null,
  ): Partial<VideoCandidate> & VideoElementDetails {
    return {
      ...(candidate || {}),
      ...videoElementDetails(video),
    };
  }

  function findOverlayCandidate(video: HTMLVideoElement, candidates: VideoCandidate[]): VideoCandidate | undefined {
    return candidates.find((candidate) => videoFilters.isLikelyRealVideoElement(videoMetrics(video, candidate)));
  }

  function scanTextForMediaUrls(text: string, source: string): VideoCandidate[] {
    const candidates: VideoCandidate[] = [];
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
