/**
 * Site-derived thumbnail URLs (spec `thumbnail-spec.md` §4).
 *
 * Pure URL-in / URL-out: nothing here fetches, and nothing here guesses a CDN's
 * query contract. It exists because the only other sources are metadata the page
 * may not publish (`og:image` and friends) and a `poster` attribute many players
 * never set — and because the one authoritative source, yt-dlp's own
 * `info["thumbnail"]`, only arrives when the user opens the quality dialog
 * (`background/format_helpers.ts`). A `youtube.com/watch?v=…` URL already *is* the
 * answer; it just has to be spelled out.
 *
 * Adding a host here is a deliberate act, not a fallback for a failed parse: a
 * wrong id shape produces a 404 that costs one request per row per popup open.
 */

/**
 * How many candidate URLs a row may try.
 *
 * Three is the whole budget: each one is a third-party request from an extension
 * page, and a media list can hold dozens of rows. A list that is exhausted falls
 * back to the blurred play-icon tile, which is honest — three misses means the art
 * genuinely is not reachable.
 */
export const THUMBNAIL_CANDIDATE_LIMIT = 3;

/** YouTube ids are 11 chars of URL-safe base64; allow a little slack for shorts. */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{8,20}$/;
const VIMEO_ID_RE = /^\d{4,15}$/;
const DAILYMOTION_ID_RE = /^[A-Za-z0-9]{4,24}$/;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const DAILYMOTION_HOSTS = new Set(["dailymotion.com", "www.dailymotion.com", "geo.dailymotion.com", "dai.ly"]);

/** `https://www.youtube.com/watch?v=<id>`, `…/shorts/<id>`, `…/embed/<id>`, `…/live/<id>`. */
function youtubeId(parsed: URL): string {
  if (parsed.hostname === "youtu.be" || parsed.hostname === "www.youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] || "";
    return YOUTUBE_ID_RE.test(id) ? id : "";
  }

  if (parsed.searchParams.get("v")) {
    const id = parsed.searchParams.get("v") || "";
    return YOUTUBE_ID_RE.test(id) ? id : "";
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const marker = segments.findIndex((segment) => ["shorts", "embed", "live", "v"].includes(segment));
  const id = marker >= 0 ? segments[marker + 1] || "" : "";
  return YOUTUBE_ID_RE.test(id) ? id : "";
}

/** `https://vimeo.com/<id>` and `https://player.vimeo.com/video/<id>`. */
function vimeoId(parsed: URL): string {
  const segments = parsed.pathname.split("/").filter(Boolean);
  const marker = segments.findIndex((segment) => segment === "video");
  const id = marker >= 0 ? segments[marker + 1] || "" : segments[0] || "";
  return VIMEO_ID_RE.test(id) ? id : "";
}

/** `https://dai.ly/<id>` and `https://www.dailymotion.com/video/<id>` (`…/embed/video/<id>`). */
function dailymotionId(parsed: URL): string {
  const segments = parsed.pathname.split("/").filter(Boolean);
  const marker = segments.findIndex((segment) => segment === "video");
  const id = marker >= 0 ? segments[marker + 1] || "" : segments[0] || "";
  return DAILYMOTION_ID_RE.test(id) ? id : "";
}

/**
 * The thumbnail a page URL implies, or `""` when the host is not one of the three
 * this knows. Callers pass the *page* URL first and the media URL second, so a
 * `youtube.com/watch?v=…` page wins over a bare `.mp4` that happens to sit on a
 * YouTube CDN host.
 */
export function deriveSiteThumbnail(pageUrl: unknown): string {
  const value = String(pageUrl || "");
  if (!value) {
    return "";
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (_error) {
    return "";
  }

  if (YOUTUBE_HOSTS.has(parsed.hostname)) {
    const id = youtubeId(parsed);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
  }

  if (VIMEO_HOSTS.has(parsed.hostname)) {
    const id = vimeoId(parsed);
    return id ? `https://vumbnail.com/${id}.jpg` : "";
  }

  if (DAILYMOTION_HOSTS.has(parsed.hostname)) {
    const id = dailymotionId(parsed);
    return id ? `https://www.dai.ly/thumbnail/video/${id}` : "";
  }

  return "";
}

/**
 * Drop repeats and empty strings, keeping first-seen order. Dedupe matters more
 * than it looks: `hqdefault` and the og:image are frequently the same file, and
 * without this the row would burn a retry on a URL that just failed.
 */
export function dedupeThumbnailUrls(urls: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of urls) {
    const value = String(entry || "");
    if (value && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
