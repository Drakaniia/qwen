import type { BackgroundContext, TabId } from "./types.js";
import { THUMBNAIL_CANDIDATE_LIMIT } from "../ui/thumbnail_sources.js";

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

/**
 * The host's own artwork for one playlist item, http(s) only.
 *
 * The host resolves per-item cover art (a Spotify collection's image, yt-dlp's
 * `thumbnail`) and it used to be dropped here, so every playlist row fell back to
 * `deriveSiteThumbnail(pageUrl)` — the *playlist* page, which is not per-track.
 *
 * `data:` is filtered at this boundary rather than at the render: the ladder is copied
 * into every job record and into synced history, where a base64 JPEG per row blows the
 * ~100KB budget (see the note in `download/native.ts`). Absent art stays absent so the
 * popup's own site-derived ladder still gets its turn.
 */
function itemArtwork(entry: Record<string, unknown>): { thumbnailUrl?: string; thumbnailCandidates?: string[] } {
  const supplied = Array.isArray(entry.thumbnailCandidates) ? entry.thumbnailCandidates : [];
  const urls = [...new Set([entry.thumbnailUrl, ...supplied].map((value) => String(value || "")))].filter(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
  );
  if (!urls.length) {
    return {};
  }
  return {
    thumbnailUrl: urls[0],
    thumbnailCandidates: urls.slice(0, THUMBNAIL_CANDIDATE_LIMIT),
  };
}

/**
 * One http(s) URL, or "".
 *
 * The same boundary {@link itemArtwork} draws, kept for the folder's own cover: a
 * native host is not a trust boundary we can assume never answers `data:` (an ffmpeg
 * frame grab already proves one path can), and the folder cover rides along on every
 * row of the playlist.
 */
function httpUrl(value: unknown): string {
  const text = String(value || "");
  return text.startsWith("http://") || text.startsWith("https://") ? text : "";
}

/**
 * Expand a playlist URL to tab-scoped video rows.
 *
 * `isCollection` is the host's own answer to "was this really a list?", and it is the
 * only trustworthy one: `yt-dlp --flat-playlist --dump-json` emits exactly one entry for
 * an ordinary video URL, so a one-item result cannot be read as "small playlist" without
 * losing the quality sheet for every plain paste. The popup gates on that flag rather
 * than on a length guess.
 *
 * `truncated` / `totalItems` come from the same message (spec §4): a 300-track playlist
 * is enumerated as its first 100, and the popup has to be able to say so.
 *
 * ## The three `playlist*` fields are the popup's folder key
 *
 * `playlistId` is the playlist URL itself, un-hashed. It is already unique per
 * enumeration and it is already on every row's `pageUrl`, so it is free — importing
 * `hashId` to shorten a key nothing displays would buy nothing and cost a dependency
 * from a module that currently has one import. The popup only ever compares it for
 * equality (`state/playlists.ts`), so its length is irrelevant.
 *
 * Deliberately NOT `groupId`: that field is read by the download path as the primary
 * candidate of a variant (`download/native.ts`), so a playlist id stamped there would
 * send wrong ids to the helper for every row of the playlist.
 */
export async function enumeratePlaylistVideos(
  ctx: PlaylistCtx,
  tabId: TabId,
  url: string,
): Promise<{
  videoIds: string[];
  playlistId: string;
  playlistTitle: string;
  playlistThumbnailUrl: string;
  isCollection: boolean;
  totalItems: number;
  truncated: boolean;
}> {
  const reply = await ctx.nativeRequest(
    { type: "enumeratePlaylist", id: `pl_${Date.now()}`, url, pageUrl: url },
    ENUMERATE_TIMEOUT_MS,
  );
  const items = Array.isArray(reply.items) ? reply.items : [];
  if (!items.length) {
    throw new Error("That playlist has no playable items.");
  }
  const playlistTitle = String(reply.playlistTitle || "Playlist");
  const playlistThumbnailUrl = httpUrl(reply.playlistThumbnailUrl);
  const videoIds: string[] = [];
  for (const [index, item] of items.entries()) {
    const entry = item as Record<string, unknown>;
    const video = await ctx.addDetectedVideo(tabId, {
      url: (entry.url || entry.spotifyUrl) as string,
      title: (entry.title || `Track ${index + 1}`) as string,
      pageUrl: url,
      source: "playlist",
      ...itemArtwork(entry),
      playlistId: url,
      playlistTitle,
      playlistThumbnailUrl,
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
  return {
    videoIds,
    playlistId: url,
    playlistTitle,
    playlistThumbnailUrl,
    isCollection: reply.isCollection === true,
    totalItems: Number(reply.totalItems) || items.length,
    truncated: reply.truncated === true,
  };
}
