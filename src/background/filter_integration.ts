import * as filterListLoader from "../shared/filter_list_loader.js";
import * as mediaCandidates from "../shared/media_candidates.js";

// ── State ────────────────────────────────────────────────────────────────

let videoExceptionDomains = new Set<string>();
let filterRefreshTimer: ReturnType<typeof setInterval> | null = null;
const FILTER_REFRESH_INTERVAL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

// ── Initialization ───────────────────────────────────────────────────────

/**
 * Initialise the filter list integration at extension startup.
 * 1. Loads compiled patterns from cache (exception domains)
 * 2. Schedules periodic refresh of all filter lists
 */
async function initFilterIntegration(): Promise<void> {
  try {
    const patterns = await filterListLoader.getActivePatterns();
    if (patterns && patterns.exceptionDomains && patterns.exceptionDomains.length > 0) {
      videoExceptionDomains = new Set(patterns.exceptionDomains);
    } else {
      // Cache is empty (first install) — trigger an immediate refresh so
      // filter-based exceptions are available right away, not after 5 days.
      try {
        await filterListLoader.refreshAllLists();
        const updated = await filterListLoader.getActivePatterns();
        if (updated && updated.exceptionDomains) {
          videoExceptionDomains = new Set(updated.exceptionDomains);
        }
      } catch (_error) {
        // First refresh is best-effort
      }
    }
  } catch (_error) {
    // Filter integration is best-effort — failure should not block startup
  }

  // Schedule background refresh every 5 days
  if (filterRefreshTimer) {
    clearInterval(filterRefreshTimer);
  }
  filterRefreshTimer = setInterval(async () => {
    try {
      await filterListLoader.refreshAllLists();
      const updated = await filterListLoader.getActivePatterns();
      if (updated && updated.exceptionDomains) {
        videoExceptionDomains = new Set(updated.exceptionDomains);
      }
    } catch (_error) {
      // Refresh failure is non-critical
    }
  }, FILTER_REFRESH_INTERVAL_MS);
}

// ── Filter-aware URL blocking ────────────────────────────────────────────

/**
 * Check if a URL is blocked, with filter-list exception domains applied.
 */
function isBlockedUrlWithFilters(url: string, contentType = ""): boolean {
  return mediaCandidates.isBlockedMediaUrlWithExceptions(url, contentType, videoExceptionDomains);
}

export { initFilterIntegration, isBlockedUrlWithFilters };
