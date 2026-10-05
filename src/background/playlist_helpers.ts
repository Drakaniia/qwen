import { hashId } from "./video_utils.js";
import type { BackgroundContext, TabId } from "./types.js";

/**
 * The two context fields enumeration needs. Narrowed to a `Pick` for the same reason
 * `BackgroundContext`'s other injected modules are: a rename upstream is still a compile
 * error here, and nothing else in the module can reach the rest of the context.
 */
type PlaylistCtx = Pick<BackgroundContext, "nativeRequest" | "addDetectedVideo">;

/**
 * Playlist enumeration. Long timeout because a 100-item playlist is 100 extractor round
 * trips inside the helper; the default request timeout would abandon a slow but
 * perfectly healthy enumeration.
 */
const ENUMERATE_TIMEOUT_MS = 90000;

/** Expand a playlist URL to tab-scoped video rows sharing one groupId. */
export async function enumeratePlaylistVideos(
  ctx: PlaylistCtx,
  tabId: TabId,
  url: string,
): Promise<{ videoIds: string[]; playlistTitle: string; totalItems: number }> {
  const reply = await ctx.nativeRequest(
    { type: "enumeratePlaylist", id: `pl_${Date.now()}`, url, pageUrl: url },
    ENUMERATE_TIMEOUT_MS,
  );
  const items = Array.isArray(reply.items) ? reply.items : [];
  if (!items.length) {
    throw new Error("That playlist has no playable items.");
  }
  // One groupId per playlist URL, not per item — the popup groups the rows back together
  // and "Download all" needs to know they came from the same enumeration. The repo's own
  // `hashId` rather than a second hash function: two hashes of the same string must agree.
  const groupId = `playlist_${hashId(url).slice(2)}`;
  const videoIds: string[] = [];
  for (const [index, item] of items.entries()) {
    const entry = item as Record<string, unknown>;
    const video = await ctx.addDetectedVideo(tabId, {
      url: (entry.url || entry.spotifyUrl) as string,
      title: (entry.title || `Track ${index + 1}`) as string,
      pageUrl: url,
      source: "playlist",
      groupId,
      downloadable: true,
    });
    // A null means the detector filtered that item (ad, GIF, unsupported URL). Skipping it
    // is the point — the rest of the playlist is still downloadable.
    if (video?.id) {
      videoIds.push(String(video.id));
    }
  }
  if (!videoIds.length) {
    throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
  }
  return { videoIds, playlistTitle: String(reply.playlistTitle || "Playlist"), totalItems: items.length };
}
