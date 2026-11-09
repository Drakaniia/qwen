/**
 * Message handlers barrel.
 *
 * Spec D4 moved registration out of `message_router.ts` and into the handler modules
 * themselves. This barrel exists only to hand each registrar the runtime context
 * `background.ts` built — it deliberately names **no** message type, so a new
 * message never requires touching it.
 */
import { registerTabHandlers } from "./tab.js";
import { registerDownloadHandlers } from "./download.js";
import { registerSettingsHandlers } from "./settings.js";
import { registerThumbnailFrameHandlers } from "./thumbnailFrame.js";
import { registerThumbnailFramesHandlers } from "./thumbnailFrames.js";

import type { BackgroundContext } from "../types.js";

export {
  registerTabHandlers,
  registerDownloadHandlers,
  registerSettingsHandlers,
  registerThumbnailFrameHandlers,
  registerThumbnailFramesHandlers,
};

/**
 * Register ALL message handlers into `message_router.ts`'s dispatch map.
 */
export function registerAllHandlers(ctx: BackgroundContext): void {
  registerTabHandlers(ctx);
  registerDownloadHandlers(ctx);
  registerSettingsHandlers(ctx);
  registerThumbnailFrameHandlers(ctx);
  registerThumbnailFramesHandlers(ctx);
}
