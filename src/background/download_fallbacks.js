(function attachQwinDownloadFallbacks(root, factory) {
  const downloadFallbacks = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = downloadFallbacks;
  }
  root.QwinDownloadFallbacks = downloadFallbacks;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinDownloadFallbacks() {
  "use strict";

  const HARD_ACCESS_ERROR_RE =
    /\bHTTP Error\s+(?:401|403|404|410|451)\b|\b(?:Unauthorized|Forbidden|Gone|Not Found|Unavailable For Legal Reasons)\b|Invalid data found when processing input/i;
  const RETRYABLE_SOURCE_ERROR_RE =
    /Unsupported URL|did not find any downloadable video formats|No video formats|Requested format is not available|Invalid data found when processing input/i;

  function isHardAccessError(error) {
    return HARD_ACCESS_ERROR_RE.test(String(error || ""));
  }

  function isRetryableSourceError(error) {
    const text = String(error || "");
    return isHardAccessError(text) || RETRYABLE_SOURCE_ERROR_RE.test(text);
  }

  function exhaustedSourcesError(error, attemptedUrls) {
    const count = attemptedUrls && attemptedUrls.size ? attemptedUrls.size : 1;
    const details = String(error || "The helper could not download this source.").trim();
    return count > 1 ? `${details}\nTried ${count} sources.` : details;
  }

  function downloadableVariants(video, attemptedUrls, deps) {
    const variants = [
      ...deps.variantsForVideo(video),
      ...(Array.isArray(video?.groupVariants) ? video.groupVariants : []),
    ];
    const seenUrls = new Set();
    const result = [];

    for (const variant of variants) {
      const url = deps.normalizeUrl(variant?.url || "");
      if (!url || seenUrls.has(url) || attemptedUrls.has(url) || !variant.downloadable) {
        continue;
      }
      seenUrls.add(url);
      result.push(variant);
    }

    return result;
  }

  function isExtractorPageVideo(video) {
    const format = String(video?.format || "").toUpperCase();
    return video?.source === "manual-url" || video?.source === "youtube-page" || format === "PAGE" || format === "YOUTUBE";
  }

  function pageFallbackVideoForSource(video, attemptedUrls, deps) {
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

  function resolverUrlsForSource(sourceVideo, deps) {
    const urls = [
      sourceVideo?.pageUrl || "",
      sourceVideo?.frameUrl || "",
      sourceVideo?.url || "",
    ];
    const seen = new Set();
    const result = [];

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

  async function resolveMediaCandidatesForSource(tabId, sourceVideo, attemptedUrls, deps) {
    const resolverUrls = resolverUrlsForSource(sourceVideo, deps);
    if (!resolverUrls.length) {
      return [];
    }

    const rawCandidates = [];
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
            requestHeaders: await deps.nativeRequestHeadersForVideo(url, sourceVideo.pageUrl || sourceVideo.frameUrl || ""),
          },
          20000
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

    const candidates = [];
    const seenCandidateUrls = new Set();
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
      const detected = await deps.addDetectedVideo(tabId, {
        url: candidate.url,
        format: candidate.format || deps.detectFormat(candidate.url, candidate.contentType || ""),
        source: candidate.source || "resolved-page",
        contentType: candidate.contentType || "",
        title: candidate.title || title || sourceVideo.title || deps.titleFromUrl(candidate.url),
        pageUrl: sourceVideo.pageUrl || sourceVideo.url || "",
        frameUrl: sourceVideo.frameUrl || sourceVideo.pageUrl || "",
        downloadable: true,
        duration: sourceVideo.duration || null,
        width: sourceVideo.width || null,
        height: sourceVideo.height || null,
        bitrate: candidate.bitrate || null,
        thumbnailUrl: sourceVideo.thumbnailUrl || "",
      });
      candidates.push({
        ...(detected || candidate),
        url: candidate.url,
        id: detected?.id || candidate.id || deps.hashId(candidate.url),
        format: candidate.format || detected?.format || deps.detectFormat(candidate.url, candidate.contentType || ""),
        source: candidate.source || detected?.source || "resolved-page",
        title: detected?.title || candidate.title || title || sourceVideo.title || deps.titleFromUrl(candidate.url),
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

  async function fallbackVideoForDownload(tabId, failedVideo, attemptedUrls, deps) {
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

  return {
    downloadableVariants,
    exhaustedSourcesError,
    fallbackVideoForDownload,
    isExtractorPageVideo,
    isHardAccessError,
    isRetryableSourceError,
    pageFallbackVideoForSource,
    resolveMediaCandidatesForSource,
    resolverUrlsForSource,
  };
});
