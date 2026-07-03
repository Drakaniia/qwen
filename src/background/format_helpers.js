"use strict";

import * as tabState from "./tab_state.js";
import * as videoFilters from "../shared/video_filters.js";
import { browserApi } from "../shared/browser_api.js";
import * as downloadHelpers from "./download_helpers.js";
import * as videoUtils from "./video_utils.js";
import * as headerUtils from "./header_utils.js";
import { SIZE_PROBE_LIMIT_PER_GROUP, probeVideoSize, updateVideoSize } from "./size_probe.js";

// ── Source helpers ───────────────────────────────────────────────────────

function sourceHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function sourceText(video) {
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

function detectedVariantOption(variant) {
  const height = Number(variant.height || 0);
  const width = Number(variant.width || 0);
  const ext = videoFilters.displayVideoFormat(variant);
  const quality = height ? `${height}p` : width ? `${width}w` : ext;
  return {
    id: `variant:${variant.id}`,
    formatId: "best",
    variantId: variant.id,
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

function normalizeNativeFormatOption(format, video) {
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

async function updateGroupedTitle(tabId, video, title, getVisibleVideosFn, notifyPopupFn) {
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

async function ensureComparisonSizes(tabId, video, getVisibleVideosFn, notifyPopupFn) {
  const variantsToProbe = downloadHelpers.variantsForVideo(video)
    .filter((variant) => videoUtils.canProbeVideoSize(variant))
    .slice(0, SIZE_PROBE_LIMIT_PER_GROUP);

  if (!variantsToProbe.length) {
    return video;
  }

  const results = await Promise.all(
    variantsToProbe.map(async (variant) => ({
      id: variant.id,
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
    const grouped = downloadHelpers.findGroupedVideoForVariant(tabId, downloadHelpers.variantsForVideo(video)[0], getVisibleVideosFn);
    return grouped || video;
  }

  return video;
}

async function requestNativeFormats(video, nativeRequestFn) {
  const requestId = `formats_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const currentSettings = tabState.getSettings();
  return nativeRequestFn({
    type: "formats",
    id: requestId,
    url: video.url,
    pageUrl: video.pageUrl || "",
    userAgent: navigator.userAgent || "",
    requestHeaders: await headerUtils.nativeRequestHeadersForVideo(video.url, video.pageUrl || ""),
    musicMode: currentSettings.musicMode || false,
    audioFormat: currentSettings.audioFormat || "mp3",
  });
}

async function notifyContentStatus(tabId, text) {
  if (!tabId) return;
  await browserApi.tabs.sendMessage(tabId, { type: "updateLoadingStatus", text });
}

function notifyPopupQualityStatus(notifyPopupFn, text) {
  if (notifyPopupFn) {
    notifyPopupFn({ type: "updateQualityLoadingStatus", text });
  }
}

function notifyDownloadDebugLog(notifyPopupFn, level, message, details) {
  if (notifyPopupFn) {
    notifyPopupFn({ type: "downloadDebugLog", level, message, details: details || "" });
  }
}

async function getNativeFormatsForVideo(
  tabId,
  video,
  getVisibleVideosFn,
  notifyPopupFn,
  nativeRequestFn,
  addDetectedVideoFn,
) {
  await tabState.load();

  const sizeProbePromise = ensureComparisonSizes(tabId, video, getVisibleVideosFn, notifyPopupFn);
  const lookupVideo = downloadHelpers.preferredNativeVideo(video);
  let formatLookupVideo = lookupVideo;
  let response = null;
  let nativeError = "";
  let firstNativeError = "";

  const log = (level, message, details) => {
    notifyDownloadDebugLog(notifyPopupFn, level, message, details);
  };

  const status = (text) => {
    notifyContentStatus(tabId, text);
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
    nativeError = error.message || String(error);
    firstNativeError = nativeError;
    log("error", "yt-dlp format check failed", nativeError);
    const pageFallback = downloadHelpers.isRetryableSourceError(nativeError)
      ? await downloadHelpers.pageFallbackVideoForSource(lookupVideo, new Set([headerUtils.normalizeUrl(lookupVideo.url || "")]), buildFallbackDeps(getVisibleVideosFn, addDetectedVideoFn, nativeRequestFn))
      : null;
    if (pageFallback) {
      log("warn", "yt-dlp failed, trying page URL fallback", `Fallback URL: ${pageFallback.url ? pageFallback.url.substring(0, 120) : "N/A"}`);
      await status("Checking page fallback...");
      try {
        response = await requestNativeFormats(pageFallback, nativeRequestFn);
        formatLookupVideo =
          (await addDetectedVideoFn(tabId, {
            ...pageFallback,
            title: pageFallback.title || lookupVideo.title || video.title,
            duration: pageFallback.duration || lookupVideo.duration || video.duration,
            width: pageFallback.width || lookupVideo.width || video.width,
            height: pageFallback.height || lookupVideo.height || video.height,
            bitrate: pageFallback.bitrate || lookupVideo.bitrate || video.bitrate,
            thumbnailUrl: pageFallback.thumbnailUrl || lookupVideo.thumbnailUrl || video.thumbnailUrl,
            downloadable: true,
          })) || pageFallback;
        nativeError = "";
        log("info", "Page URL fallback succeeded", `Found ${response && response.formats ? response.formats.length : 0} format(s)`);
      } catch (pageError) {
        nativeError = pageError.message || String(pageError);
        log("error", "Page URL fallback also failed", nativeError);
      }
    }
    if (!response && downloadHelpers.isRetryableSourceError(nativeError)) {
      log("warn", "Trying resolved media candidates as fallback...");
      const resolvedCandidates = await downloadHelpers.resolveMediaCandidatesForSource(
        tabId,
        pageFallback || lookupVideo,
        new Set([headerUtils.normalizeUrl(lookupVideo.url || "")]),
        buildFallbackDeps(getVisibleVideosFn, addDetectedVideoFn, nativeRequestFn),
      );
      if (resolvedCandidates.length > 0) {
        log("info", `Found ${resolvedCandidates.length} resolved source(s) to try`);
        await status(`Checking ${resolvedCandidates.length} resolved source(s)...`);
      }
      for (const candidate of resolvedCandidates) {
        try {
          const idx = resolvedCandidates.indexOf(candidate) + 1;
          log("info", `Trying resolved source ${idx}/${resolvedCandidates.length}`, candidate.url ? candidate.url.substring(0, 120) : "N/A");
          await status(
            `Checking source ${idx} of ${resolvedCandidates.length}...`,
          );
          response = await requestNativeFormats(candidate, nativeRequestFn);
          formatLookupVideo = candidate;
          nativeError = "";
          log("info", `Resolved source ${idx} succeeded`, `Found ${response && response.formats ? response.formats.length : 0} format(s)`);
          break;
        } catch (candidateError) {
          nativeError = candidateError.message || String(candidateError);
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

  const firstHardNativeError = firstNativeError && downloadHelpers.isHardAccessError(firstNativeError);
  const hardNativeError = nativeError && !nativeFormats.length && downloadHelpers.isHardAccessError(nativeError);
  if (firstHardNativeError) {
    await downloadHelpers.markVideoUrlUnavailable(tabId, lookupVideo.url, firstNativeError, getVisibleVideosFn, notifyPopupFn);
  } else if (hardNativeError) {
    await downloadHelpers.markVideoUrlUnavailable(tabId, formatLookupVideo.url, nativeError, getVisibleVideosFn, notifyPopupFn);
  }

  let refreshedVideo = null;
  if (nativeFormats.length > 0) {
    if (response && response.title) {
      await updateGroupedTitle(tabId, formatLookupVideo, response.title, getVisibleVideosFn, notifyPopupFn);
    }
    refreshedVideo = downloadHelpers.findGroupedVideoForAnyVariant(tabId, formatLookupVideo, getVisibleVideosFn) || formatLookupVideo;
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
  const excludedUrls = new Set();
  if (firstHardNativeError) {
    excludedUrls.add(headerUtils.normalizeUrl(lookupVideo.url || ""));
  }
  if (hardNativeError) {
    excludedUrls.add(headerUtils.normalizeUrl(formatLookupVideo.url || ""));
  }

  const sourceFormats = nativeFormats.length
    ? []
    : downloadHelpers.isExtractorPageVideo(refreshedVideo)
      ? []
      : downloadHelpers.downloadableVariants(refreshedVideo, excludedUrls, buildFallbackDeps(getVisibleVideosFn, addDetectedVideoFn, nativeRequestFn)).map(detectedVariantOption);

  if (nativeError && !nativeFormats.length && !sourceFormats.length) {
    const friendlyError = downloadHelpers.userFriendlyDownloadError(nativeError);
    const errorMsg = friendlyError ? `${friendlyError}\n\nTechnical details: ${nativeError}` : nativeError;
    log("error", "Format enumeration failed - no formats found", nativeError);
    throw new Error(errorMsg);
  }
  if (!nativeFormats.length && !sourceFormats.length) {
    log("error", "No downloadable formats from yt-dlp or detected sources", `video URL: ${(video.url || "").substring(0, 120)}`);
    throw new Error("yt-dlp did not find any downloadable video formats for this link.");
  }

  log("info", `Format enumeration complete: ${nativeFormats.length} native + ${sourceFormats.length} detected format(s)`);

  const formats = nativeFormats.length ? nativeFormats : sourceFormats;
  const pageTitle = refreshedVideo.title || lookupVideo.title || "Video";
  const serverTitle = response && response.title && !videoFilters.isGenericTitle(response.title) ? response.title : "";
  const serverThumbnail = response && response.thumbnailUrl ? response.thumbnailUrl : "";

  if (serverThumbnail) {
    await tabState.patchVideo(
      tabId,
      (item) => item.id === refreshedVideo.id || downloadHelpers.variantsForVideo(item).some((v) => v.id === refreshedVideo.id),
      { thumbnailUrl: serverThumbnail },
    );
  }

  const finalTitle = serverTitle || pageTitle;

  // If native response has subtitle availability info, update video state
  if (response && response.hasSubtitles) {
    await tabState.patchVideo(
      tabId,
      (item) => item.id === refreshedVideo.id || downloadHelpers.variantsForVideo(item).some((v) => v.id === refreshedVideo.id),
      {
        hasSubtitles: true,
        subtitleLanguages: (response.subtitleLanguages) || 0,
      },
    );
  }

  return {
    videoId: refreshedVideo.id || formatLookupVideo.id || lookupVideo.id,
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

// ── Internal: build fallback deps for format retrieval ───────────────────

function buildFallbackDeps(getVisibleVideosFn, addDetectedVideoFn, nativeRequestFn) {
  return {
    ...downloadHelpers.buildDownloadFallbackDeps(nativeRequestFn, addDetectedVideoFn, getVisibleVideosFn),
    nativeRequestHeadersForVideo: headerUtils.nativeRequestHeadersForVideo,
  };
}

export {
  sourceHost,
  sourceText,
  detectedVariantOption,
  normalizeNativeFormatOption,
  updateGroupedTitle,
  ensureComparisonSizes,
  requestNativeFormats,
  notifyContentStatus,
  notifyPopupQualityStatus,
  notifyDownloadDebugLog,
  getNativeFormatsForVideo,
};
