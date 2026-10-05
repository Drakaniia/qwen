import { register } from "../message_router.js";
import type { BackgroundContext, HandlerMessage, MessageOf } from "../types.js";

/**
 * The lazy ffmpeg-frame grab (`hls-thumbnail-spec.md` §6.1).
 *
 * The popup fires this when a row's ladder is exhausted and does not await it — H8: the
 * glyph stays on screen until `videoListUpdated` brings the frame. So the reply carries
 * nothing useful and the handler's own work is one lookup plus the grab itself.
 */
export function registerThumbnailFrameHandlers(ctx: BackgroundContext): void {
  const { senderTabId, thumbnailFrames } = ctx;

  register({
    name: "grabThumbnailFrame",
    async handle(message: HandlerMessage<MessageOf<"grabThumbnailFrame">>) {
      const tabId = senderTabId(message, message.sender);
      await thumbnailFrames.grabFrame(tabId, message.videoId);
      return { ok: true };
    },
  });
}
