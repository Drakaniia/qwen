"use strict";

/**
 * CDP-based URL Extraction Module
 *
 * Uses Chrome DevTools Protocol (via chrome.debugger) to extract video source
 * URLs from dynamically-loaded pages. This handles sites where yt-dlp cannot
 * find the media URL, such as:
 * - Custom HTML5 video players
 * - Anti-bot protected pages (Cloudflare, etc.)
 * - Pages with __NEXT_DATA__ / __NUXT__ / playerConfig
 */

export { attach, detach, sendCommand, cleanup, activeSessions } from "./session.js";
export { getExtractionScript, getMutationWatchScript, getEventSimulationScript } from "./scripts.js";
export { discoverFrameTree, flattenFrameTree, evaluateInFrame } from "./iframe.js";
export { extractVideosFromTab, extractVideosWithMutationWatch } from "./extraction.js";
export { simulateVideoEvents } from "./simulation.js";
