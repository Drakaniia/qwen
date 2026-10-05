/**
 * The external download tools the Python native helper shells out to, and the
 * keys it reports them under in the `pong` payload's `dependencies` object.
 *
 * This table is the single source of truth for both UIs (the popup's dependency
 * banner and the Options → Native helper section). Adding a tool means adding
 * one entry here plus the matching key in `host.py:dependency_status()` —
 * no UI control flow is edited (spec D4).
 *
 * Ordering is deliberate and load-bearing: `required` tools gate the download
 * path, `optional` ones are best-effort fallbacks that widen coverage when
 * present. The Options page renders this order verbatim.
 */

export interface HelperDependency {
  /** Key in the `pong` payload's `dependencies` object (`host.py`). */
  readonly key: string;
  /** Human-readable tool name, used in the Options list. */
  readonly name: string;
  /** What the tool actually does for us — shown on hover and in the docs. */
  readonly purpose: string;
  /** True when a download cannot proceed at all without it. */
  readonly required: boolean;
  /** Short label for the popup's one-line dependency banner. */
  readonly bannerLabel: string;
}

export const HELPER_DEPENDENCIES: readonly HelperDependency[] = [
  {
    key: "ytDlp",
    name: "yt-dlp",
    purpose: "Format enumeration and the primary download path for 1000+ sites.",
    required: true,
    bannerLabel: "yt-dlp (video downloads)",
  },
  {
    key: "ffmpeg",
    name: "ffmpeg",
    purpose: "Merges separate video/audio tracks and does post-processing.",
    required: true,
    bannerLabel: "ffmpeg (audio/video processing)",
  },
  {
    key: "aria2c",
    name: "aria2c",
    purpose: "Segmented parallel transfer. Speeds up large files, no format knowledge.",
    required: true,
    bannerLabel: "aria2c (fast downloads)",
  },
  {
    key: "nM3u8DlRe",
    name: "N_m3u8DL-RE",
    purpose: "Preferred HLS/DASH/ISM downloader — parallel segments, AES-128, live.",
    required: false,
    bannerLabel: "HLS stream downloader",
  },
  {
    key: "streamlink",
    name: "Streamlink",
    purpose: "Live-stream fallback when a site's HLS needs a real player pipeline.",
    required: false,
    bannerLabel: "Stream fallback",
  },
] as const;

/** Keys whose absence blocks a download, as opposed to merely narrowing coverage. */
export const REQUIRED_DEPENDENCY_KEYS: readonly string[] = HELPER_DEPENDENCIES.filter((dep) => dep.required).map(
  (dep) => dep.key,
);

/**
 * `host.py` reports `{ ytDlp, ffmpeg, aria2c, nM3u8DlRe, streamlink }`.
 * Anything falsy there is missing — the host never sends `false` for a tool it
 * knows about, so `!dependencies[key]` is the whole check.
 */
export function isMissing(dependencies: Record<string, unknown>, key: string): boolean {
  return dependencies?.[key] !== true;
}

/**
 * True until a probe has answered.
 *
 * `isMissing` reads an absent key as missing, and `dependencies` is `{}` both when no
 * probe has answered and when the helper is unreachable — so both UIs must gate on this
 * before calling `isMissing`, or they report all five tools absent on first paint. See
 * native-helper-status-spec.md §2.2.
 */
export function isUnknown(status: { connected: boolean | null }): boolean {
  return status.connected === null;
}
