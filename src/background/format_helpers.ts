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
  userFriendlyDownloadError,
} from "./download_fallbacks.js";
import * as videoUtils from "./video_utils.js";
import * as headerUtils from "./header_utils.js";
import { probeMediaUrls } from "./media_probe.js";
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

/**
 * The helper's own refusal, reproduced here so it costs no process spawn.
 *
 * `native_paths.validate_download_url` raises exactly this sentence for anything that is
 * not http(s), and it is right to: a `blob:` handle is a MediaSource pointer, not a file
 * the helper could open. Checking first keeps an MSE-only row from paying a native-host
 * spawn (0.4–3.5s) to be told what the extension already knew.
 */
const NON_FETCHABLE_URL_ERROR =
  "Only http:// and https:// media, playlist, or supported video page URLs can be sent to " +
  "yt-dlp. Browser-only blob:, data:, file:, and DRM-protected URLs cannot be downloaded this way.";

async function requestNativeFormats(video: VideoRecord, nativeRequestFn: NativeRequestFn): Promise<NativeResponse> {
  if (!/^https?:/i.test(String(video.url || ""))) {
    throw new Error(NON_FETCHABLE_URL_ERROR);
  }
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
  /**
   * Why there are no formats, in one sentence, or `""` when there are some. The dialog
   * renders this *instead of* the table — see {@link unavailableReasonFor}.
   */
  unavailableReason: string;
  hasSubtitles: boolean;
  subtitleLanguages: number;
  /**
   * The host's top-level media duration in seconds, passed through when it sent one
   * (`0` otherwise). Per-format `kind` / `vcodec` / `acodec` / `abr` / `ext` / `protocol`
   * ride on each entry of `formats` untouched — see `normalizeNativeFormatOption`.
   */
  duration: number;
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

  // Outcome, not tool: this string is shown in the quality dialog and the on-page
  // overlay, and "yt-dlp" is the helper's business, not the user's. The name belongs in
  // the `log` line below, which is the service-worker console.
  await status("Finding available versions...");
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

    // ── The last rung: ask the server ───────────────────────────────────────
    //
    // Reached only when yt-dlp AND every detected candidate have already failed, so the
    // cost is one HEAD (plus at most one ranged GET) per unclassified URL, once per
    // failed video rather than once per page.
    //
    // `video.probeUrls` is the content script's list of resource-timing URLs it had to
    // drop for looking like nothing in particular (`content.ts:unclassifiedResourceUrls`),
    // carried on the page-fallback row. The rest of the list is what this layer already
    // knows: a probed URL becomes a real detected video first, exactly as the resolver
    // fallback above does, so the reply's `videoId` points at a record whose URL is the
    // probed one and the download then resolves to it (`popup_actions.ts` prefers
    // `formatsResponse.videoId`).
    if (!response) {
      const probed = await probeMediaUrls(
        [
          video.url || "",
          video.pageUrl || "",
          video.frameUrl || "",
          ...(Array.isArray(video.probeUrls) ? video.probeUrls : []),
        ],
        {
          nativeRequest: nativeRequestFn,
          isBlockedMediaUrl: (url: string, contentType = "") => videoFilters.isBlockedVideoUrl(url, contentType),
          normalizeUrl: headerUtils.normalizeUrl,
          nativeRequestHeadersForVideo: headerUtils.nativeRequestHeadersForVideo,
          userAgent: navigator.userAgent || "",
          pageUrl: video.pageUrl || video.frameUrl || "",
        },
      );

      if (probed.length) {
        log("info", `Probe found ${probed.length} media source(s) no pattern recognized`);
        await status(`Checking ${probed.length} probed source(s)...`);
      }

      for (const source of probed) {
        try {
          log("info", `Trying probed ${source.kind} source`, source.url.substring(0, 120));
          const detected = await addDetectedVideoFn(tabId, {
            url: source.url,
            format: source.format,
            source: "media-probe",
            contentType: source.contentType,
            title: lookupVideo.title || video.title || "",
            pageUrl: video.pageUrl || video.frameUrl || "",
            frameUrl: video.frameUrl || "",
            downloadable: true,
            duration: video.duration || null,
            width: video.width || null,
            height: video.height || null,
            thumbnailUrl: video.thumbnailUrl || "",
          });
          const probedVideo: VideoRecord = detected || video;
          response = await requestNativeFormats(probedVideo, nativeRequestFn);
          formatLookupVideo = probedVideo;
          nativeError = "";
          log(
            "info",
            `Probed source succeeded`,
            `Found ${response && response.formats ? response.formats.length : 0} format(s)`,
          );
          break;
        } catch (sourceError) {
          nativeError = (sourceError as Error).message || String(sourceError);
          log("error", "Probed source failed", nativeError);
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

  // Audio-only renditions arrive in their own `audioFormats` list (`yt_dlp_command.py`)
  // so a consumer that does not know `kind` can never show 128 kbps as a video quality.
  // Both surfaces that render this reply — the popup's and the overlay's `QualityDialog` —
  // split one list on `kind`/`vcodec` into Video and Audio-only sections, so the two
  // lists are joined here, video first. Each audio `id` is a complete selector
  // (`<fid>/bestaudio`) that the host passes through verbatim when it comes back as the
  // chosen `formatId`.
  const nativeFormats = [
    ...(response && Array.isArray(response.formats) ? response.formats : []),
    ...(response && Array.isArray(response.audioFormats) ? response.audioFormats : []),
  ].map((format) => normalizeNativeFormatOption(format, formatLookupVideo));

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
    // An empty list, not a synthetic `Best available MP4` row. That row was a lie the
    // user could click: the helper had just refused the URL, so the download that came
    // back was always the same error, printed under a normal-looking option.
    formats,
    nativeError,
    unavailableReason: formats.length ? "" : unavailableReasonFor(refreshedVideo, nativeError),
    hasSubtitles: response && response.hasSubtitles ? true : false,
    subtitleLanguages: (response && response.subtitleLanguages) || 0,
    duration: response && typeof response.duration === "number" && response.duration > 0 ? response.duration : 0,
  };
}

// ── Unavailability ───────────────────────────────────────────────────────

/**
 * The one situation with no URL-shaped answer at all.
 *
 * A `blob:` source is a MediaSource handle: the bytes live in the player's own buffer
 * and disappear with the page, so no fetch, no probe and no extractor can reach them.
 * There is no recording path to point at (AGENTS.md: it was deleted on purpose), so the
 * sentence says what is true and what still might work: the page's own URL.
 */
const MSE_ONLY_REASON =
  "This video plays through a browser-managed stream and exposes no link the helper can " +
  "fetch. Try downloading the page's own address instead — paste it into the popup.";

function isMseOnlySource(video: VideoRecord): boolean {
  if (video.source === "mse-player") {
    return true;
  }
  return [video.url || "", ...downloadHelpers.variantsForVideo(video).map((variant) => variant.url || "")].some((url) =>
    String(url).toLowerCase().startsWith("blob:"),
  );
}

/**
 * Why a video produced no formats, as the sentence the dialog shows in place of a row.
 *
 * Order is the contract: an MSE handle is a fact about the source that the helper's
 * error text cannot express (all it can say is "only http(s) URLs"), so it is named
 * first. Everything else is the helper's own message through
 * `userFriendlyDownloadError`, falling back to the raw text because a specific yt-dlp
 * complaint is more useful than a generic apology.
 */
function unavailableReasonFor(video: VideoRecord, nativeError: string): string {
  if (isMseOnlySource(video)) {
    return MSE_ONLY_REASON;
  }
  const friendly = userFriendlyDownloadError(nativeError);
  if (friendly) {
    return friendly;
  }
  const details = String(nativeError || "").trim();
  return details || "No downloadable versions were found for this video.";
}

// ── Public surface ───────────────────────────────────────────────────────
//
// `getVideoFormats`, `getFormatsForUrl` and `getBestVideoFormats` are the only messages
// that enumerate formats, and `BackgroundContext.formatHelpers` is narrowed to
// `getNativeFormatsForVideo` alone. `unavailableReasonFor` is exported for its own test:
// it is a pure function over a record and an error string, and the popup's "why not"
// sentence is the part of this file most worth pinning down without a native host.
export { getNativeFormatsForVideo, unavailableReasonFor };
