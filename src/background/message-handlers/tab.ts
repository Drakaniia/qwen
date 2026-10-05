import { register } from "../message_router.js";
import type { BackgroundContext, HandlerMessage, MessageOf, VideoInput } from "../types.js";

/**
 * Tab/content video message handlers.
 *
 * Every `register(...)` call below is the module's whole contribution to dispatch.
 * Nothing here is imported by `message_router.ts` and no message type is named
 * anywhere else — adding a tab message means adding one entry to this list.
 */
export function registerTabHandlers(ctx: BackgroundContext): void {
  const {
    senderTabId,
    notifyPopup,
    getVisibleVideosForTab,
    addDetectedVideo,
    clearTab,
    getTabVideos,
    getAllDownloadsSorted,
    setPageTitle,
    tabState,
    browserApi,
  } = ctx;

  // ── Content detected videos ────────────────────────────────────────────

  register({
    name: "contentDetectedVideos",
    async handle(message: HandlerMessage<MessageOf<"contentDetectedVideos">>) {
      const { sender } = message;
      const tabId = senderTabId(message, sender);
      const videos = Array.isArray(message.videos) ? message.videos : [];

      if (sender?.tab?.title) {
        setPageTitle(tabId, sender.tab.title);
      }

      await tabState.load();
      let changed = false;

      for (const video of videos) {
        const added = await addDetectedVideo(
          tabId,
          {
            ...video,
            source: video.source || "dom",
            pageUrl: video.pageUrl || (sender.tab && sender.tab.url) || "",
            frameUrl: video.frameUrl || sender.url || "",
          },
          false,
        );
        if (added) changed = true;
      }

      if (changed) {
        notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
      }
      return { ok: true };
    },
  });

  // ── Get videos ─────────────────────────────────────────────────────────

  register({
    name: "getVideos",
    async handle(message: HandlerMessage<MessageOf<"getVideos">>) {
      const tabId = senderTabId(message, message.sender);
      return {
        ok: true,
        videos: await getTabVideos(tabId),
        // Global: a download belongs to the machine, not the tab that started it.
        downloads: await getAllDownloadsSorted(),
        settings: tabState.getSettings(),
      };
    },
  });

  // ── Rescan tab ─────────────────────────────────────────────────────────

  register({
    name: "rescanTab",
    async handle(message: HandlerMessage<MessageOf<"rescanTab">>) {
      const { sender } = message;
      const tabId = senderTabId(message, sender);
      await clearTab(tabId);

      const contentResponse = (await browserApi.tabs.sendMessage(tabId as number, { type: "scanNow" })) as {
        ok?: boolean;
        videos?: VideoInput[];
      } | null;

      if (contentResponse && contentResponse.ok && Array.isArray(contentResponse.videos)) {
        for (const video of contentResponse.videos) {
          await addDetectedVideo(
            tabId,
            {
              ...video,
              source: video.source || "dom",
              pageUrl: video.pageUrl || (sender.tab && sender.tab.url) || "",
              frameUrl: video.frameUrl || sender.url || "",
            },
            false,
          );
        }
        notifyPopup({ type: "videoListUpdated", tabId, videos: getVisibleVideosForTab(tabId) });
      }

      await browserApi.scripting.executeScript({
        target: { tabId: tabId as number, allFrames: true },
        func: () => window.dispatchEvent(new CustomEvent("qwin-video-scan-now")),
      });
      return { ok: true };
    },
  });

  // ── Clear tab ──────────────────────────────────────────────────────────

  register({
    name: "clearVideos",
    async handle(message: HandlerMessage<MessageOf<"clearVideos">>) {
      await clearTab(senderTabId(message, message.sender));
      return { ok: true };
    },
  });
}
