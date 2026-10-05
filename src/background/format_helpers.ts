import * as tabState from "./tab_state.js";
import * as videoFilters from "../shared/video_filters.js";
import { browserApi } from "../shared/browser_api.js";
import * as downloadHelpers from "./download_helpers.js";
import {
  downloadableVariants,
  isExtractorPageVideo,
  isHardAccessError,
  isRetryableSourceError,
  pageFallbackVideoForSource,
  resolveMediaCandidatesForSource,
} from "./download_fallbacks.js";
import * as videoUtils from "./video_utils.js";
import * as headerUtils from "./header_utils.js";
import { SIZE_PROBE_LIMIT_PER_GROUP, probeVideoSize, updateVideoSize } from "./size_probe.js";
import type {
  DownloadFallbackDeps,
  FormatOption,
  NativeRequestFn,
  NativeResponse,
  NotifyPopup,
  TabId,
  VideoInput,
  VideoRecord,
} from "./types.js";

// ── Source helpers ───────────────────────────────────────────────────────
//
// Everything above `getNativeFormatsForVideo` is a step of that one function, and
// `BackgroundContext.formatHelpers` is narrowed to that function alone — so none of
// these need an `export`.

function sourceHost(url?: string): string {
  try {
    return new URL(url as string).hostname;
  } catch (_error) {
    return "";
  }
}

function sourceText(video: VideoRecord): string {
  if (video.source === "youtube-page" || String(video.format || "").toUpperCase() === "YOUTUBE") {
    return "YouTube full video";
  }
  if (video.source === "manual-url" || String(video.format || "").toUpperCase() === "PAGE") {
    return "Manual link";
  }
  if (video.source === "music-page") {
    return [sourceHost(video.url), "music"].filter(Boolean).join(" / ");
  }
  return [video.source || "detected", sourceHost(video.url)].filter(Boolean).join(" / ");
}

// ── Variant option helpers ───────────────────────────────────────────────

function detectedVariantOption(variant: VideoRecord): FormatOption {
  const height = Number(variant.height || 0);
  const width = Number(variant.width || 0);
  const ext = videoFilters.displayVideoFormat(variant);
  const quality = height ? `${height}p` : width ? `${width}w` : ext;
  return {
    id: `variant:${variant.id}`,
    formatId: "best",
    variantId: variant.id as string,
    backend: variant.backend || "auto",
    fallbackReason: variant.fallbackReason || "",
    optionType: "detected-source",
    label: `${quality} ${ext}`.trim(),
    ext,
    height: height || null,
    width: width || null,
    tbr: variant.tbr || variant.bitrate || null,
    bitrate: variant.bitrate || variant.tbr || null,
    size: variant.size || videoFilters.displayVideoSize(variant),
    sizeBytes: variant.sizeBytes || null,
    note: "Detected source",
    source: sourceText(variant),
    sourceUrl: variant.url,
  };
}

function normalizeNativeFormatOption(format: Record<string, any>, video: VideoRecord): FormatOption {
  const ext = format.ext || (format.id === "best" ? "mp4" : "");
  return {
    ...format,
    id: format.id || "best",
    formatId: format.id || "best",
    variantId: video.source === "page-fallback" ? video.id || "" : "",
    backend: format.backend || video.backend || "auto",
    fallbackReason: format.fallbackReason || "",
    optionType: "native-format",
    ext,
    source: format.source || `yt-dlp / ${sourceHost(video.url) || "detected source"}`,
  };
}

// ── Title update helpers ─────────────────────────────────────────────────

async function updateGroupedTitle(
  tabId: TabId,
  video: VideoRecord,
  title: string | undefined,
  getVisibleVideosFn: (tabId: TabId) => VideoRecord[],
  notifyPopupFn?: NotifyPopup,
): Promise<void> {
  if (!title || videoFilters.isGenericTitle(title)) {
    return;
  }

  const variantIds = new Set(downloadHelpers.variantsForVideo(video).map((variant) => variant.id));
  await tabState.mutateVideos(tabId, function (list) {
    return list.map((item) => (variantIds.has(item.id) ? Object.assign({}, item, { title: title }) : item));
  });
  if (notifyPopupFn) {
    notifyPopupFn({ type: "videoListUpdated", tabId, videos: getVisibleVideosFn(tabId) });
  }
}

// ── Native format retrieval ──────────────────────────────────────────────

async function ensureComparisonSizes(
  tabId: TabId,
  video: VideoRecord,
  getVisibleVideosFn: (tabId: TabId) => VideoRecord[],
  notifyPopupFn?: NotifyPopup,
): Promise<VideoRecord> {
  const variantsToProbe = downloadHelpers
    .variantsForVideo(video)
    .filter((variant) => videoUtils.canProbeVideoSize(variant))
    .slice(0, SIZE_PROBE_LIMIT_PER_GROUP);

  if (!variantsToProbe.length) {
    return video;
  }

  const results = await Promise.all(
    variantsToProbe.map(async (variant) => ({
      id: variant.id as string,
      sizeBytes: await probeVideoSize(variant),
    })),
  );

  let changed = false;
  for (const result of results) {
    if (result.sizeBytes) {
      changed = (await updateVideoSize(tabId, result.id, result.sizeBytes)) || changed;
    }
  }

  if (changed) {
    await tabState.persistVideos();
    if (notifyPopupFn) {
      notifyPopupFn({ type: "videoListUpdated", tabId, videos: getVisibleVideosFn(tabId) });
    }
    const grouped = downloadHelpers.findGroupedVideoForVariant(
      tabId,
      downloadHelpers.variantsForVideo(video)[0],
      getVisibleVideosFn,
    );
    return grouped || video;
  }

  return video;
}

async function requestNativeFormats(video: VideoRecord, nativeRequestFn: NativeRequestFn): Promise<NativeResponse> {
  const requestId = `formats_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const currentSettings = tabState.getSettings();
  return nativeRequestFn({
    type: "formats",
    id: requestId,
    url: video.url,
    pageUrl: video.pageUrl || "",
    userAgent: navigator.userAgent || "",
    requestHeaders: await headerUtils.nativeRequestHeadersForVideo(video.url as string, video.pageUrl || ""),
    musicMode: currentSettings.musicMode || false,
    audioFormat: currentSettings.audioFormat || "mp3",
  });
}

async function notifyContentStatus(tabId: TabId, text: string): Promise<void> {
  if (!tabId) return;
  await browserApi.tabs.sendMessage(tabId, { type: "updateLoadingStatus", text });
}

function notifyPopupQualityStatus(notifyPopupFn: NotifyPopup | undefined, text: string): void {
  if (notifyPopupFn) {
    notifyPopupFn({ type: "updateQualityLoadingStatus", text });
  }
}

/** The shape `getNativeFormatsForVideo` answers with; spread into `{ ok: true, ... }`. */
interface NativeFormatsResult {
  videoId: string;
  title: string;
  thumbnailUrl: string;
  formats: FormatOption[];
  nativeError: string;
  hasSubtitles: boolean;
  subtitleLanguages: number;
}

async function getNativeFormatsForVideo(
  tabId: TabId,
  video: VideoRecord,
  getVisibleVideosFn: (tabId: TabId) => VideoRecord[],
  notifyPopupFn: NotifyPopup | undefined,
  nativeRequestFn: NativeRequestFn,
  addDetectedVideoFn: DownloadFallbackDeps["addDetectedVideo"],
): Promise<NativeFormatsResult> {
  await tabState.load();

  const fallbackDeps = downloadHelpers.buildDownloadFallbackDeps(
    nativeRequestFn,
    addDetectedVideoFn,
    getVisibleVideosFn,
  );
  const sizeProbePromise = ensureComparisonSizes(tabId, video, getVisibleVideosFn, notifyPopupFn);
  const lookupVideo = downloadHelpers.preferredNativeVideo(video);
  let formatLookupVideo = lookupVideo;
  let response: NativeResponse | null = null;
  let nativeError = "";
  let firstNativeError = "";

  // Enumeration is a multi-second network walk; these are the only record of which
  // branch the user is waiting on, and the service worker console is the only place
  // they survive a service-worker teardown.
  const log = (level: string, message: string, details?: unknown) => {
    console.debug(`[qwin:${level}] ${message}`, details || "");
  };

  const status = (text: string) => {
    void notifyContentStatus(tabId, text);
    notifyPopupQualityStatus(notifyPopupFn, text);
  };

  const sourceUrl = lookupVideo.url || video.url || "";

  log("info", `Starting format enumeration for: ${sourceUrl.substring(0, 120)}`);

  await status("Checking link with yt-dlp...");
  try {
    log("info", "Checking link with yt-dlp...");
    response = await requestNativeFormats(formatLookupVideo, nativeRequestFn);
    if (response && response.formats) {
      log("info", `yt-dlp succeeded: found ${response.formats.length} format(s)`);
    } else if (response) {
      log("warn", "yt-dlp returned response but no formats found");
    } else {
      log("warn", "yt-dlp returned empty response");
    }
  } catch (error) {
    nativeError = (error as Error).message || String(error);
    firstNativeError = nativeError;
    log("error", "yt-dlp format check failed", nativeError);
    const pageFallback = isRetryableSourceError(nativeError)
      ? await pageFallbackVideoForSource(
          lookupVideo,
          new Set([headerUtils.normalizeUrl(lookupVideo.url || "")]),
          fallbackDeps,
        )
      : null;
    if (pageFallback) {
      log(
        "warn",
        "yt-dlp failed, trying page URL fallback",
        `Fallback URL: ${pageFallback.url ? pageFallback.url.substring(0, 120) : "N/A"}`,
      );
      await status("Checking page fallback...");
      try {
        response = await requestNativeFormats(pageFallback, nativeRequestFn);
        const pageFallbackInput: VideoInput = {
          ...pageFallback,
          title: pageFallback.title || lookupVideo.title || video.title,
          duration: pageFallback.duration || lookupVideo.duration || video.duration,
          width: pageFallback.width || lookupVideo.width || video.width,
          height: pageFallback.height || lookupVideo.height || video.height,
          bitrate: pageFallback.bitrate || lookupVideo.bitrate || video.bitrate,
          thumbnailUrl: pageFallback.thumbnailUrl || lookupVideo.thumbnailUrl || video.thumbnailUrl,
          downloadable: true,
        };
        formatLookupVideo = (await addDetectedVideoFn(tabId, pageFallbackInput)) || pageFallback;
        nativeError = "";
        log(
          "info",
          "Page URL fallback succeeded",
          `Found ${response && response.formats ? response.formats.length : 0} format(s)`,
        );
      } catch (pageError) {
        nativeError = (pageError as Error).message || String(pageError);
        log("error", "Page URL fallback also failed", nativeError);
      }
    }
    if (!response && isRetryableSourceError(nativeError)) {
      log("warn", "Trying resolved media candidates as fallback...");
      const resolvedCandidates = await resolveMediaCandidatesForSource(
        tabId,
        pageFallback || lookupVideo,
        new Set([headerUtils.normalizeUrl(lookupVideo.url || "")]),
        fallbackDeps,
      );
      if (resolvedCandidates.length > 0) {
        log("info", `Found ${resolvedCandidates.length} resolved source(s) to try`);
        await status(`Checking ${resolvedCandidates.length} resolved source(s)...`);
      }
      for (const candidate of resolvedCandidates) {
        try {
          const idx = resolvedCandidates.indexOf(candidate) + 1;
          log(
            "info",
            `Trying resolved source ${idx}/${resolvedCandidates.length}`,
            candidate.url ? candidate.url.substring(0, 120) : "N/A",
          );
          await status(`Checking source ${idx} of ${resolvedCandidates.length}...`);
          response = await requestNativeFormats(candidate, nativeRequestFn);
          formatLookupVideo = candidate;
          nativeError = "";
          log(
            "info",
            `Resolved source ${idx} succeeded`,
            `Found ${response && response.formats ? response.formats.length : 0} format(s)`,
          );
          break;
        } catch (candidateError) {
          nativeError = (candidateError as Error).message || String(candidateError);
          log("error", `Resolved source ${resolvedCandidates.indexOf(candidate) + 1} failed`, nativeError);
        }
      }
    }
  }

  if (!response) {
    log("warn", "No response from native host, waiting for size probe fallback...");
    await status("Waiting for video size information...");
  } else if (response && response.formats && response.formats.length) {
    log("info", `Processing ${response.formats.length} available format(s) from native host`);
    await status("Processing available formats...");
  } else if (response) {
    log("warn", "Native host returned response but no formats found", JSON.stringify(response).substring(0, 300));
  }

  const nativeFormats =
    response && response.formats && response.formats.length
      ? response.formats.map((format) => normalizeNativeFormatOption(format, formatLookupVideo))
      : [];

  const firstHardNativeError = Boolean(firstNativeError && isHardAccessError(firstNativeError));
  const hardNativeError = Boolean(nativeError && !nativeFormats.length && isHardAccessError(nativeError));
  if (firstHardNativeError) {
    await downloadHelpers.markVideoUrlUnavailable(
      tabId,
      lookupVideo.url as string,
      firstNativeError,
      getVisibleVideosFn,
      notifyPopupFn,
    );
  } else if (hardNativeError) {
    await downloadHelpers.markVideoUrlUnavailable(
      tabId,
      formatLookupVideo.url as string,
      nativeError,
      getVisibleVideosFn,
      notifyPopupFn,
    );
  }

  let refreshedVideo: VideoRecord;
  if (nativeFormats.length > 0) {
    if (response && response.title) {
      await updateGroupedTitle(tabId, formatLookupVideo, response.title, getVisibleVideosFn, notifyPopupFn);
    }
    refreshedVideo =
      downloadHelpers.findGroupedVideoForAnyVariant(tabId, formatLookupVideo, getVisibleVideosFn) || formatLookupVideo;
  } else {
    const sizedVideo = await sizeProbePromise;
    if (response && response.title) {
      await updateGroupedTitle(tabId, sizedVideo, response.title, getVisibleVideosFn, notifyPopupFn);
    }
    refreshedVideo =
      downloadHelpers.findGroupedVideoForAnyVariant(tabId, formatLookupVideo, getVisibleVideosFn) ||
      downloadHelpers.findGroupedVideoForAnyVariant(tabId, sizedVideo, getVisibleVideosFn) ||
      formatLookupVideo ||
      sizedVideo;
  }
  const excludedUrls = new Set<string>();
  if (firstHardNativeError) {
    excludedUrls.add(headerUtils.normalizeUrl(lookupVideo.url || ""));
  }
  if (hardNativeError) {
    excludedUrls.add(headerUtils.normalizeUrl(formatLookupVideo.url || ""));
  }

  const sourceFormats: FormatOption[] = nativeFormats.length
    ? []
    : isExtractorPageVideo(refreshedVideo)
      ? []
      : downloadableVariants(refreshedVideo, excludedUrls, fallbackDeps).map(detectedVariantOption);

  if (nativeError && !nativeFormats.length && !sourceFormats.length) {
    log("warn", "Format enumeration found no formats, using fallback", nativeError);
  }
  if (!nativeFormats.length && !sourceFormats.length) {
    log(
      "warn",
      "No downloadable formats from yt-dlp or detected sources, using fallback",
      `video URL: ${(video.url || "").substring(0, 120)}`,
    );
  }

  log(
    "info",
    `Format enumeration complete: ${nativeFormats.length} native + ${sourceFormats.length} detected format(s)`,
  );

  const formats = nativeFormats.length ? nativeFormats : sourceFormats;
  const pageTitle = refreshedVideo.title || lookupVideo.title || "Video";
  const serverTitle = response && response.title && !videoFilters.isGenericTitle(response.title) ? response.title : "";
  const serverThumbnail = response && response.thumbnailUrl ? response.thumbnailUrl : "";

  if (serverThumbnail) {
    await tabState.patchVideo(
      tabId,
      (item) =>
        item.id === refreshedVideo.id || downloadHelpers.variantsForVideo(item).some((v) => v.id === refreshedVideo.id),
      { thumbnailUrl: serverThumbnail },
    );
  }

  const finalTitle = serverTitle || pageTitle;

  // If native response has subtitle availability info, update video state
  if (response && response.hasSubtitles) {
    await tabState.patchVideo(
      tabId,
      (item) =>
        item.id === refreshedVideo.id || downloadHelpers.variantsForVideo(item).some((v) => v.id === refreshedVideo.id),
      {
        hasSubtitles: true,
        subtitleLanguages: response.subtitleLanguages || 0,
      },
    );
  }

  return {
    videoId: refreshedVideo.id || formatLookupVideo.id || (lookupVideo.id as string),
    title: finalTitle,
    thumbnailUrl: serverThumbnail || refreshedVideo.thumbnailUrl || "",
    formats: formats.length
      ? formats
      : [
          normalizeNativeFormatOption(
            { id: "best", label: "Best available MP4", ext: "mp4", note: "Recommended" },
            lookupVideo,
          ),
        ],
    nativeError,
    hasSubtitles: response && response.hasSubtitles ? true : false,
    subtitleLanguages: (response && response.subtitleLanguages) || 0,
  };
}

// ── Public surface ───────────────────────────────────────────────────────
//
// Exactly one export: `getVideoFormats`, `getFormatsForUrl` and `getBestVideoFormats`
// are the only messages that enumerate formats, and `BackgroundContext.formatHelpers`
// is narrowed to this name.
export { getNativeFormatsForVideo };
