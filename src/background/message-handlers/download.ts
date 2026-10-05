import { register } from "../message_router.js";
import { enumeratePlaylistVideos } from "../playlist_helpers.js";
import type { BackgroundContext, HandlerMessage, MessageOf } from "../types.js";

/**
 * Download control message handlers.
 *
 * Each `register(...)` below owns one wire message type. `message_router.ts` never
 * learns these names — it looks them up in the dispatch map it owns.
 */
export function registerDownloadHandlers(ctx: BackgroundContext): void {
  const {
    senderTabId,
    getTabVideos,
    getVisibleVideosForTab,
    addDetectedVideo,
    chooseDownloadFolder,
    tabState,
    nativeRequest,
    notifyPopup,
  } = ctx;
  const { variantsForVideo, findGroupedVideoForVariant } = ctx.downloadHelpers;
  const { getNativeFormatsForVideo } = ctx.formatHelpers;
  const {
    startNativeDownload,
    startNativeDownloadForUrl,
    getBestDownloadableVideo,
    startBestNativeDownload,
    downloadMany,
    controlActiveDownload,
    resumeDownload,
    cancelDownload,
    retryDownload,
    openDownloadedPath,
    removeDownload,
    clearDownloads,
  } = ctx;

  // ── Folder picker helper ───────────────────────────────────────────────

  function chooseFolderHandler() {
    return chooseDownloadFolder().then((result) => ({ ok: true, ...result }));
  }

  // ── Download video ─────────────────────────────────────────────────────

  register({
    name: "downloadVideo",
    async handle(message: HandlerMessage<MessageOf<"downloadVideo">>) {
      const tabId = senderTabId(message, message.sender);
      return {
        ok: true,
        ...(await startNativeDownload(
          tabId,
          message.videoId,
          message.formatId || "best",
          message.variantId || "",
          message.backend || "auto",
        )),
      };
    },
  });

  // ── Download control ───────────────────────────────────────────────────

  register({
    name: "pauseDownload",
    handle(message: MessageOf<"pauseDownload">) {
      return { ok: true, ...controlActiveDownload(message.jobId, "pause") };
    },
  });

  register({
    name: "resumeDownload",
    async handle(message: HandlerMessage<MessageOf<"resumeDownload">>) {
      const tabId = senderTabId(message, message.sender);
      return { ok: true, ...(await resumeDownload(tabId, message.jobId)) };
    },
  });

  register({
    name: "cancelDownload",
    async handle(message: HandlerMessage<MessageOf<"cancelDownload">>) {
      const tabId = senderTabId(message, message.sender);
      return { ok: true, ...(await cancelDownload(tabId, message.jobId)) };
    },
  });

  register({
    name: "retryDownload",
    async handle(message: HandlerMessage<MessageOf<"retryDownload">>) {
      const tabId = senderTabId(message, message.sender);
      return { ok: true, ...(await retryDownload(tabId, message.jobId)) };
    },
  });

  register({
    name: "openDownloadedFile",
    async handle(message: MessageOf<"openDownloadedFile">) {
      return { ok: true, ...(await openDownloadedPath(message.jobId, "openFile")) };
    },
  });

  register({
    name: "showDownloadedFile",
    async handle(message: MessageOf<"showDownloadedFile">) {
      return { ok: true, ...(await openDownloadedPath(message.jobId, "showFile")) };
    },
  });

  register({
    name: "removeDownload",
    async handle(message: MessageOf<"removeDownload">) {
      return { ok: true, ...(await removeDownload(message.jobId)) };
    },
  });

  register({
    name: "clearDownloads",
    async handle() {
      return { ok: true, ...(await clearDownloads()) };
    },
  });

  // ── Get video formats ──────────────────────────────────────────────────

  register({
    name: "getVideoFormats",
    async handle(message: HandlerMessage<MessageOf<"getVideoFormats">>) {
      const tabId = senderTabId(message, message.sender);
      const videos = await getTabVideos(tabId);
      const video = videos.find(
        (item) =>
          item.id === message.videoId || variantsForVideo(item).some((variant) => variant.id === message.videoId),
      );
      if (!video) {
        throw new Error("That video URL is no longer in the detected list.");
      }
      return {
        ok: true,
        ...(await getNativeFormatsForVideo(
          tabId,
          video,
          getVisibleVideosForTab,
          notifyPopup,
          nativeRequest,
          addDetectedVideo,
        )),
      };
    },
  });

  // ── Download URL ───────────────────────────────────────────────────────

  register({
    name: "downloadUrl",
    async handle(message: HandlerMessage<MessageOf<"downloadUrl">>) {
      const { sender } = message;
      const tabId = senderTabId(message, sender);
      return {
        ok: true,
        ...(await startNativeDownloadForUrl(tabId, {
          ...(message.video || {}),
          pageUrl: (message.video && message.video.pageUrl) || (sender.tab && sender.tab.url) || "",
          frameUrl: sender.url || "",
          formatId: message.formatId || "best",
          variantId: message.variantId || "",
        })),
      };
    },
  });

  // ── Download best video ──────────────────────────────────────────────

  register({
    name: "downloadBestVideo",
    async handle(message: HandlerMessage<MessageOf<"downloadBestVideo">>) {
      const tabId = senderTabId(message, message.sender);
      return {
        ok: true,
        ...(await startBestNativeDownload(tabId, message.formatId || "best", message.variantId || "")),
      };
    },
  });

  // ── Get formats for URL ──────────────────────────────────────────────

  register({
    name: "getFormatsForUrl",
    async handle(message: HandlerMessage<MessageOf<"getFormatsForUrl">>) {
      const { sender } = message;
      const tabId = senderTabId(message, sender);
      const video = await addDetectedVideo(tabId, {
        ...(message.video || {}),
        pageUrl: (message.video && message.video.pageUrl) || (sender.tab && sender.tab.url) || "",
        frameUrl: sender.url || "",
        source: (message.video && message.video.source) || "overlay",
      });
      if (!video) {
        throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
      }
      const groupedVideo = findGroupedVideoForVariant(tabId, video, getVisibleVideosForTab) || video;
      // `getNativeFormatsForVideo` re-resolves the grouped id itself and returns it as
      // `videoId`, so the reply's id comes from the enumeration, not from
      // `groupedVideo.id`.
      return {
        ok: true,
        ...(await getNativeFormatsForVideo(
          tabId,
          groupedVideo,
          getVisibleVideosForTab,
          notifyPopup,
          nativeRequest,
          addDetectedVideo,
        )),
      };
    },
  });

  // ── Enumerate a playlist ──────────────────────────────────────────────

  register({
    name: "enumeratePlaylist",
    async handle(message: HandlerMessage<MessageOf<"enumeratePlaylist">>) {
      const tabId = senderTabId(message, message.sender);
      return { ok: true, ...(await enumeratePlaylistVideos(ctx, tabId, String(message.url || ""))) };
    },
  });

  register({
    name: "downloadMany",
    async handle(message: HandlerMessage<MessageOf<"downloadMany">>) {
      const tabId = senderTabId(message, message.sender);
      const ids = Array.isArray(message.videoIds) ? message.videoIds.map(String) : [];
      return { ok: true, ...(await downloadMany(tabId, ids, message.formatId || "best")) };
    },
  });

  // ── Get best video formats ────────────────────────────────────────────

  register({
    name: "getBestVideoFormats",
    async handle(message: HandlerMessage<MessageOf<"getBestVideoFormats">>) {
      const tabId = senderTabId(message, message.sender);
      const video = await getBestDownloadableVideo(tabId);
      return {
        ok: true,
        ...(await getNativeFormatsForVideo(
          tabId,
          video,
          getVisibleVideosForTab,
          notifyPopup,
          nativeRequest,
          addDetectedVideo,
        )),
      };
    },
  });

  // ── Folder picker ──────────────────────────────────────────────────────

  register({ name: "chooseDownloadFolder", handle: chooseFolderHandler });

  // ── Download history sync ──────────────────────────────────────────────

  register({
    name: "getDownloadSyncHistory",
    handle() {
      const history = ctx.downloadSync.getSyncedHistory();
      const syncInfo = ctx.downloadSync.getSyncInfo();
      return { ok: true, history, syncInfo };
    },
  });

  register({
    name: "setDownloadSyncEnabled",
    async handle(message: MessageOf<"setDownloadSyncEnabled">) {
      const enabled = message.enabled !== false;
      ctx.downloadSync.setSyncEnabled(enabled);
      const currentSettings = tabState.getSettings();
      await tabState.setSettings(Object.assign({}, currentSettings, { downloadSyncEnabled: enabled }));
      return { ok: true, enabled };
    },
  });

  register({
    name: "clearDownloadSyncHistory",
    async handle() {
      ctx.downloadSync.clearSyncedHistory();
      await tabState.persistSyncHistoryToStorage();
      return { ok: true };
    },
  });
}
