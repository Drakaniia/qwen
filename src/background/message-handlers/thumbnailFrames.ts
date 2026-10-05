import { register } from "../message_router.js";
import type { BackgroundContext, HandlerMessage, MessageOf } from "../types.js";

/**
 * Cached frames for a whole visible list (`hls-thumbnail-spec.md` §5.3).
 *
 * One message for the page rather than one per row, and a **lookup, never a grab**: the
 * downloads page has no tab, so nothing here could budget a spawn, and a row whose URL is
 * not cached simply keeps the glyph `HistoryRow.Thumb` already renders.
 *
 * `MAX_URLS` is a trust boundary, not a policy: `urls` arrives as an arbitrary `string[]`
 * off the message channel, and the frame cache holds at most 64 entries, so anything past
 * a couple of hundred can only be junk.
 */
const MAX_URLS = 200;

export function registerThumbnailFramesHandlers(ctx: BackgroundContext): void {
  const { thumbnailFrames } = ctx;

  register({
    name: "thumbnailFrames",
    handle(message: HandlerMessage<MessageOf<"thumbnailFrames">>) {
      const urls = (Array.isArray(message.urls) ? message.urls : []).filter(
        (url): url is string => typeof url === "string" && !!url,
      );
      return { ok: true, frames: thumbnailFrames.framesForUrls(urls.slice(0, MAX_URLS)) };
    },
  });
}
