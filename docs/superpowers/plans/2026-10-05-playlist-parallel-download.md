# Playlist parallel download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pasted or detected playlist URLs (Spotify first, generic yt-dlp second) expand into rows that download 3-at-a-time.

**Architecture:** Native host enumerates playlist items (new Spotify embed parser + `enumeratePlaylist` Spotify branch); background owns a `downloadMany` queue capped at 3 active native ports reusing `startNativeDownloadFromVideo`; popup expands items to tab-scoped rows and the selection bar executes the batch. One deviation from the spec: no ThreadPool in the native host — resolution is lazy (each download resolves its own YouTube match at start via the existing `run_spotify_fallback_download` path), so the background cap of 3 already bounds concurrent `ytsearch` probes.

**Tech Stack:** Python stdlib (`urllib`, `json`, `re`), TypeScript/Preact signals, yt-dlp `--flat-playlist`, pytest, vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-playlist-parallel-download-design.md`

## Global Constraints

- `src/content/content.ts` and `src/background/background.ts` stay IIFE (esbuild owns them; never Vite).
- Never write `qwinSettings` to `storage.local` directly; settings go through the background `saveSettings` message.
- Videos are tab-scoped; downloads are global — no `tabId` filter on download reads; `DownloadJob.tabId` is provenance only.
- Python imports are flat (`from spotify_metadata import …`), never `backends.x.y`.
- No new runtime dependencies (`motion` stays the only one).
- Type/radius/spacing tokens only; no arbitrary Tailwind values; no emoji in `src/`.
- Conventional commits with scopes (`feat(native):`, `feat(background):`, `feat(popup):`, `test(extension):`).

---

## File map

| File                                                   | Responsibility                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `src/native_host/backends/spotify/spotify_metadata.py` | += `fetch_spotify_collection_tracks` (embed playlist/album parse)         |
| `src/native_host/backends/spotify/spotify_resolver.py` | += `resolve_spotify_playlist`, `PLAYLIST_ITEM_LIMIT = 100`                |
| `src/native_host/backends/format_list.py`              | `enumeratePlaylist` += Spotify branch                                     |
| `src/shared/contracts.ts`                              | += `enumeratePlaylist`, `downloadMany` message types + payload interfaces |
| `src/shared/popup_api.ts`                              | += `enumeratePlaylist`, `downloadMany` clients                            |
| `src/background/download/index.ts`                     | += `downloadMany` queue, `MAX_CONCURRENT_DOWNLOADS = 3`                   |
| `src/background/message-handlers/download.ts`          | += register both handlers                                                 |
| `src/popup/popup_url_events.ts`                        | `resolvePastedUrl` += playlist branch                                     |
| `src/popup/views/PopupFrame.tsx`                       | `batchDownloadStub` → real executor                                       |
| `src/popup/views/SelectionBar.tsx`                     | drop `BATCH_PENDING_REASON` disabled state                                |
| `tests/native/test_spotify_playlist.py`                | new: collection parse, cap, branch dispatch                               |
| `tests/js/background/download_many.test.ts`            | new: queue cap, failure isolation                                         |
| `tests/js/popup/playlist_expand.test.ts`               | new: expand-to-rows, single-track fallback                                |

---

### Task 1: Spotify collection parser + playlist resolver

**Files:**

- Modify: `src/native_host/backends/spotify/spotify_metadata.py`
- Modify: `src/native_host/backends/spotify/spotify_resolver.py`
- Test: `tests/native/test_spotify_playlist.py` (create)

**Interfaces:**

- Consumes: `parse_spotify_url`, `HostError` (both already in tree).
- Produces: `resolve_spotify_playlist(url, yt_dlp_command=None, ffmpeg_location=None) -> {"playlistTitle": str, "items": [{"artist": str, "title": str, "spotifyUrl": str, "url": str}], "totalItems": int}` — Task 2 calls it.

- [ ] **Step 1: Write the failing test**

```python
"""Spotify playlist/album expansion (playlist parallel download)."""
import sys
from pathlib import Path
from unittest.mock import patch

_NH = Path(__file__).resolve().parents[2] / "src" / "native_host"


def _add_to_path():
    for root, dirs, _ in _NH.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))


_add_to_path()

import spotify_metadata as meta  # noqa: E402

NEXT_DATA = (
    '<script id="__NEXT_DATA__" type="application/json">'
    '{"props": {"pageProps": {"state": {"data": {"entity": {'
    '"name": "My Mix", "tracks": {"items": ['
    '{"name": "Song A", "artists": [{"name": "Band X"}]},'
    '{"name": "Song B", "artists": [{"name": "Singer Y"}]}'
    "]}}}}}}}</script>"
)
PAGE = f"<html><head>{NEXT_DATA}</head><body></body></html>"


class _Resp:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return PAGE.encode("utf-8")


def test_collection_parse_returns_tracks():
    with patch.object(meta.urllib.request, "urlopen", return_value=_Resp()):
        title, tracks = meta.fetch_spotify_collection_tracks("abc123", "playlist")
    assert title == "My Mix"
    assert [(t["artist"], t["title"]) for t in tracks] == [
        ("Band X", "Song A"),
        ("Singer Y", "Song B"),
    ]


def test_collection_parse_caps_at_limit():
    many = "".join(
        f'{{"name": "T{i}", "artists": [{{"name": "A{i}"}}]}}' for i in range(150)
    )
    page = (
        '<script id="__NEXT_DATA__" type="application/json">'
        '{"props": {"pageProps": {"state": {"data": {"entity": {'
        f'"name": "Big", "tracks": {{"items": [{many}]}}}}}}}}}</script>'
    )

    class _Big(_Resp):
        def read(self):
            return f"<html>{page}</html>".encode("utf-8")

    with patch.object(meta.urllib.request, "urlopen", return_value=_Big()):
        _, tracks = meta.fetch_spotify_collection_tracks("big1", "playlist")
    assert len(tracks) == meta.PLAYLIST_ITEM_LIMIT


def test_resolver_rejects_single_track_sentinel():
    from spotify_resolver import resolve_spotify_playlist
    import pytest
    from native_protocol import HostError

    with pytest.raises(HostError, match="__QWIN_SINGLE_TRACK__"):
        resolve_spotify_playlist("https://open.spotify.com/track/abc123")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/native/test_spotify_playlist.py -v`
Expected: FAIL with "has no attribute 'fetch_spotify_collection_tracks'" (and `PLAYLIST_ITEM_LIMIT`).

- [ ] **Step 3: Write minimal implementation**

In `spotify_metadata.py`, after `fetch_spotify_track_metadata`:

```python
PLAYLIST_ITEM_LIMIT = 100


def _normalize_collection_track(entry, index):
    artists = [a.get("name", "") for a in entry.get("artists", []) if isinstance(a, dict)]
    artist = ", ".join(a for a in artists if a) or "Unknown Artist"
    title = entry.get("name") or entry.get("title") or f"Track {index + 1}"
    track_id = entry.get("id") or ""
    url = f"https://open.spotify.com/track/{track_id}" if track_id else ""
    return {"artist": artist, "title": title, "spotifyUrl": url, "url": url}


def _extract_track_list(entity):
    """Spotify's embed JSON shape drifts; try known nests, else scan one level."""
    tracks = entity.get("tracks") or {}
    if isinstance(tracks, dict) and isinstance(tracks.get("items"), list):
        return tracks["items"], entity.get("name") or entity.get("title") or "Spotify playlist"
    if isinstance(tracks, list):
        return tracks, entity.get("name") or entity.get("title") or "Spotify playlist"
    for value in entity.values():
        if isinstance(value, dict) and isinstance(value.get("items"), list):
            return value["items"], entity.get("name") or entity.get("title") or "Spotify playlist"
    raise HostError("Could not find a track list on this Spotify page. Spotify may have changed their page layout.")


def fetch_spotify_collection_tracks(collection_id, kind):
    """Fetch (title, tracks) for a playlist/album embed page. Tracks capped at PLAYLIST_ITEM_LIMIT."""
    embed_url = f"https://open.spotify.com/embed/{kind}/{collection_id}"
    req = urllib.request.Request(embed_url, headers={"User-Agent": _YOUR_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        raise HostError(f"Could not reach Spotify embed page: {exc}")
    match = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not match:
        raise HostError("Could not extract playlist info from Spotify page. Spotify may have changed their page layout.")
    try:
        data = json.loads(match.group(1))
        entity = data["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError, json.JSONDecodeError) as exc:
        raise HostError(f"Failed to parse Spotify metadata: {exc}")
    raw_items, title = _extract_track_list(entity)
    tracks = [_normalize_collection_track(e, i) for i, e in enumerate(raw_items[:PLAYLIST_ITEM_LIMIT]) if isinstance(e, dict)]
    if not tracks:
        raise HostError("This Spotify playlist has no playable tracks.")
    return title, tracks
```

In `spotify_resolver.py`, append:

```python
def resolve_spotify_playlist(url, yt_dlp_command=None, ffmpeg_location=None):
    """Playlist/album URL → {playlistTitle, items, totalItems} for the popup's expand-to-rows flow."""
    from spotify_metadata import PLAYLIST_ITEM_LIMIT, fetch_spotify_collection_tracks

    content_type, collection_id = parse_spotify_url(url)
    if content_type == "track":
        raise HostError("__QWIN_SINGLE_TRACK__ Use the formats flow for individual tracks.")
    if content_type not in ("playlist", "album"):
        raise HostError(f"Qwin can only resolve Spotify tracks, playlists and albums. {content_type}s are not yet supported.")
    title, tracks = fetch_spotify_collection_tracks(collection_id, content_type)
    return {
        "playlistTitle": title,
        "items": tracks,
        "totalItems": len(tracks),
        "truncated": len(tracks) >= PLAYLIST_ITEM_LIMIT,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/native/test_spotify_playlist.py tests/native/test_host_imports.py -v`
Expected: PASS (no new imports, so the host guard stays green).

- [ ] **Step 5: Commit**

```bash
git add src/native_host/backends/spotify/spotify_metadata.py src/native_host/backends/spotify/spotify_resolver.py tests/native/test_spotify_playlist.py
git commit -m "feat(native): resolve Spotify playlists and albums to track lists"
```

---

### Task 2: `enumeratePlaylist` Spotify branch

**Files:**

- Modify: `src/native_host/backends/format_list.py`
- Test: `tests/native/test_spotify_playlist.py` (append)

**Interfaces:**

- Consumes: `resolve_spotify_playlist` from Task 1.
- Produces: `run_playlist_enumeration` sends `{"type": "playlistItems", "id", "playlistTitle", "items", "totalItems"}` for Spotify URLs — Task 3 consumes this shape.

- [ ] **Step 1: Write the failing test**

Append to `tests/native/test_spotify_playlist.py` (the implementation
imports `resolve_spotify_playlist` lazily inside the handler — flat-import
style per repo convention — so patch target
`spotify_resolver.resolve_spotify_playlist` binds at call time; `send` is
already a `run_playlist_enumeration` keyword parameter):

```python
def test_enumerate_playlist_spotify_branch():
    import format_list

    messages = []
    fake = {
        "playlistTitle": "My Mix",
        "items": [{"title": "Song A", "url": "https://open.spotify.com/track/1"}],
        "totalItems": 1,
    }
    with patch("spotify_resolver.resolve_spotify_playlist", return_value=fake) as mocked:
        format_list.run_playlist_enumeration(
            {"id": "pl_1", "url": "https://open.spotify.com/playlist/abc123"},
            send=messages.append,
        )
    mocked.assert_called_once()
    assert messages[0]["type"] == "playlistItems"
    assert messages[0]["items"][0]["title"] == "Song A"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/native/test_spotify_playlist.py::test_enumerate_playlist_spotify_branch -v`
Expected: FAIL — handler runs yt-dlp (or raises) instead of sending `playlistItems`.

- [ ] **Step 3: Write minimal implementation**

In `format_list.py`, inside `run_playlist_enumeration` right after `validate_download_url(url)`:

```python
    if is_spotify_url(url):
        from spotify_resolver import resolve_spotify_playlist

        result = resolve_spotify_playlist(
            url,
            yt_dlp_command=yt_dlp_command_resolver(),
            ffmpeg_location=ffmpeg_location_resolver(),
        )
        send({"type": "playlistItems", "id": request_id, "ok": True, **result})
        return
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/native/ -v`
Expected: PASS (all 9+ files, including `test_host_imports.py` and `test_format_list.py`).

- [ ] **Step 5: Commit**

```bash
git add src/native_host/backends/format_list.py tests/native/test_spotify_playlist.py
git commit -m "feat(native): enumerate Spotify playlists via enumeratePlaylist"
```

---

### Task 3: Wire types + background `enumeratePlaylist` handler

**Files:**

- Modify: `src/shared/contracts.ts`
- Modify: `src/shared/popup_api.ts`
- Modify: `src/background/message-handlers/download.ts`
- Test: `tests/js/background/download_many.test.ts` (create; enumerate test lives here too)

**Interfaces:**

- Consumes: native `playlistItems` shape from Task 2; `addDetectedVideo`, `nativeRequest`, `senderTabId` from handler `ctx` (all already destructured in `download.ts` except `nativeRequest` — it is in `ctx`, add to destructure).
- Produces: `PopupApi.enumeratePlaylist(tabId, url)` and handler reply `{ok, videoIds, playlistTitle, totalItems}` — Task 5 consumes them.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

// enumeratePlaylist handler contract: items become tab-scoped videos sharing one groupId.
describe("enumeratePlaylist handler", () => {
  it("adds one video per item with a shared playlist groupId", async () => {
    const added: unknown[] = [];
    const fakeCtx = {
      senderTabId: () => 7,
      addDetectedVideo: vi.fn(async (_tab: number, v: unknown) => {
        added.push(v);
        return { id: `vid_${added.length}`, ...(v as object) };
      }),
      nativeRequest: vi.fn(async () => ({
        items: [
          { title: "Song A", url: "https://open.spotify.com/track/1" },
          { title: "Song B", url: "https://open.spotify.com/track/2" },
        ],
        playlistTitle: "My Mix",
        totalItems: 2,
      })),
    };
    const { enumeratePlaylistVideos } = await import("../../../src/background/playlist_helpers.js");
    const result = await enumeratePlaylistVideos(fakeCtx as never, 7, "https://open.spotify.com/playlist/x");
    expect(result.videoIds).toHaveLength(2);
    const groups = new Set(added.map((v) => (v as { groupId: string }).groupId));
    expect(groups.size).toBe(1);
  });
});
```

Note: the handler logic lives in a helper module `src/background/playlist_helpers.ts` exporting `enumeratePlaylistVideos(ctx, tabId, url)` so it is unit-testable without the router; `download.ts` registers a thin wrapper. Create that file in Step 3. (Import prefix from `tests/js/background/` is always `../../../src/`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/background/download_many.test.ts`
Expected: FAIL with "Cannot find module '../../../src/background/playlist_helpers.js'".

- [ ] **Step 3: Write minimal implementation**

`contracts.ts` — append to `BACKGROUND_MESSAGE_TYPES` after `"getFormatsForUrl",`:

```ts
  "enumeratePlaylist",
  "downloadMany",
```

and to the `BackgroundMessage` union after the `getFormatsForUrl` line:

```ts
  | ({ type: "enumeratePlaylist" } & EnumeratePlaylistMessage)
  | ({ type: "downloadMany" } & DownloadManyMessage)
```

plus interfaces beside `GetFormatsForUrlMessage`:

```ts
export interface EnumeratePlaylistMessage {
  url?: string;
}

export interface DownloadManyMessage {
  videoIds?: string[];
  formatId?: string;
}
```

`popup_api.ts` — beside `getFormatsForUrl`:

```ts
/**
 * @param tabId @param url — playlist URL; the background expands it to rows.
 */
function enumeratePlaylist(tabId: number, url: string): Promise<MessageResult> {
  return runtimeMessage({ type: "enumeratePlaylist", tabId, url });
}

/**
 * @param tabId @param videoIds — ordered selection; background queues 3-at-a-time.
 */
function downloadMany(tabId: number, videoIds: string[], formatId = "best"): Promise<MessageResult> {
  return runtimeMessage({ type: "downloadMany", tabId, videoIds, formatId });
}
```

and add both names to the export list beside `getFormatsForUrl` (line ~224).

New `src/background/playlist_helpers.ts`:

```ts
import type { VideoRecord } from "./types.js";

interface PlaylistCtx {
  nativeRequest: (message: unknown, timeoutMs: number) => Promise<Record<string, any>>;
  addDetectedVideo: (tabId: number, input: unknown) => Promise<VideoRecord | null>;
}

/** Expand a playlist URL to tab-scoped video rows sharing one groupId. */
export async function enumeratePlaylistVideos(
  ctx: PlaylistCtx,
  tabId: number,
  url: string,
): Promise<{ videoIds: string[]; playlistTitle: string; totalItems: number }> {
  const reply = await ctx.nativeRequest(
    { type: "enumeratePlaylist", id: `pl_${Date.now()}`, url, pageUrl: url },
    90000,
  );
  const items = Array.isArray(reply.items) ? reply.items : [];
  if (!items.length) {
    throw new Error("That playlist has no playable items.");
  }
  let hash = 0;
  for (const ch of url) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  const groupId = `playlist_${hash.toString(16)}`;
  const videoIds: string[] = [];
  for (const [index, item] of items.entries()) {
    const entry = item as Record<string, unknown>;
    const video = await ctx.addDetectedVideo(tabId, {
      url: entry.url || entry.spotifyUrl,
      title: entry.title || `Track ${index + 1}`,
      pageUrl: url,
      source: "playlist",
      groupId,
      downloadable: true,
    });
    if (video?.id) {
      videoIds.push(String(video.id));
    }
  }
  if (!videoIds.length) {
    throw new Error("That media was filtered as an ad, GIF-style clip, or unsupported URL.");
  }
  return { videoIds, playlistTitle: String(reply.playlistTitle || "Playlist"), totalItems: items.length };
}
```

`download.ts` — add `nativeRequest` to the `ctx` destructure and register:

```ts
register({
  name: "enumeratePlaylist",
  async handle(message: HandlerMessage<MessageOf<"enumeratePlaylist">>) {
    const tabId = senderTabId(message, message.sender);
    return { ok: true, ...(await enumeratePlaylistVideos(ctx, tabId, String(message.url || ""))) };
  },
});
```

with `import { enumeratePlaylistVideos } from "../playlist_helpers.js";` at top.
`MessageOf<"enumeratePlaylist">` resolves via the `contracts.ts` union — no other type edit needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/background/download_many.test.ts`
Expected: PASS. Then: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts src/shared/popup_api.ts src/background/playlist_helpers.ts src/background/message-handlers/download.ts tests/js/background/download_many.test.ts
git commit -m "feat(background): enumerate playlists into tab-scoped rows"
```

---

### Task 4: `downloadMany` queue (3-at-a-time)

**Files:**

- Modify: `src/background/download/index.ts`
- Modify: `src/background/message-handlers/download.ts`
- Test: `tests/js/background/download_many.test.ts` (append)

**Interfaces:**

- Consumes: `startNativeDownload` (same module), `enumeratePlaylistVideos` result ids.
- Produces: `downloadMany` in the orchestrator return + `"downloadMany"` handler — Tasks 5–6 consume via `PopupApi.downloadMany`.

- [ ] **Step 1: Write the failing test**

Append to `tests/js/background/download_many.test.ts`:

```ts
describe("downloadMany queue", () => {
  it("starts at most 3 at once and continues after one finishes", async () => {
    let active = 0;
    let peak = 0;
    const finishers: Array<() => void> = [];
    const fakeStart = async (_tab: number, id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => finishers.push(resolve));
      active -= 1;
      return { jobId: `job_${id}` };
    };
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const queue = createBoundedQueue(3, fakeStart as never);
    const pending = ["a", "b", "c", "d", "e"].map((id) => queue.add(7, id, "best"));
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(3);
    finishers.splice(0).forEach((fn) => fn());
    const results = await Promise.all(pending);
    expect(results).toHaveLength(5);
    expect(peak).toBe(3);
  });

  it("one item failing does not cancel its siblings", async () => {
    const { createBoundedQueue } = await import("../../../src/background/download/queue.js");
    const fakeStart = async (_tab: number, id: string) => {
      if (id === "bad") throw new Error("nope");
      return { jobId: `job_${id}` };
    };
    const queue = createBoundedQueue(3, fakeStart as never);
    const results = await Promise.allSettled(["ok1", "bad", "ok2"].map((id) => queue.add(7, id, "best")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });
});
```

Queue lives in new `src/background/download/queue.ts` as `createBoundedQueue(limit, start)` so the throttle is testable without ports.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/background/download_many.test.ts`
Expected: FAIL with "Cannot find module '../../src/background/download/queue.js'".

- [ ] **Step 3: Write minimal implementation**

New `src/background/download/queue.ts`:

```ts
export type QueueStarter = (tabId: number, videoId: string, formatId: string) => Promise<{ jobId: string }>;

/** N-at-a-time starter queue. Failures reject that item only; siblings continue. */
export function createBoundedQueue(limit: number, start: QueueStarter) {
  let active = 0;
  const waiting: Array<() => void> = [];

  async function add(tabId: number, videoId: string, formatId: string): Promise<{ jobId: string }> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await start(tabId, videoId, formatId);
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  return { add };
}
```

In `download/index.ts`, after `startNativeDownload`:

```ts
const MAX_CONCURRENT_DOWNLOADS = 3;
const batchQueue = createBoundedQueue(MAX_CONCURRENT_DOWNLOADS, (queueTabId, queueVideoId, queueFormatId) =>
  startNativeDownload(queueTabId, queueVideoId, queueFormatId),
);

async function downloadMany(tabId: TabId, videoIds: string[], formatId = "best"): Promise<{ jobIds: string[] }> {
  await deps.ensureStateLoaded();
  const ids = [...new Set(videoIds)].slice(0, 100);
  if (!ids.length) {
    throw new Error("Select at least one video first.");
  }
  const started = await Promise.allSettled(ids.map((id) => batchQueue.add(tabId, id, formatId)));
  const jobIds: string[] = [];
  for (const result of started) {
    if (result.status === "fulfilled") {
      jobIds.push(result.value.jobId);
    }
  }
  if (!jobIds.length) {
    throw new Error("None of those downloads could start.");
  }
  return { jobIds };
}
```

Add `downloadMany` to the returned object and import `createBoundedQueue` from `"./queue.js"`. Cap 100 mirrors `MAX_VIDEOS_PER_TAB` (`video_utils.ts:13`) — one screen of rows, never more.

`download.ts` — register beside `downloadVideo`:

```ts
register({
  name: "downloadMany",
  async handle(message: HandlerMessage<MessageOf<"downloadMany">>) {
    const tabId = senderTabId(message, message.sender);
    const ids = Array.isArray(message.videoIds) ? message.videoIds.map(String) : [];
    return { ok: true, ...(await downloadMany(tabId, ids, message.formatId || "best")) };
  },
});
```

destructuring `downloadMany` from `ctx` at the top of `registerDownloadHandlers` next to `startNativeDownload`. `ctx` here is `BackgroundContext` — the orchestrator's return (which now includes `downloadMany`) is spread into it in `background.ts`; verify that spread while editing (it already spreads `...ops` output for the other methods).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/background/download_many.test.ts; if ($?) { npm run typecheck }`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/background/download/queue.ts src/background/download/index.ts src/background/message-handlers/download.ts tests/js/background/download_many.test.ts
git commit -m "feat(background): 3-at-a-time downloadMany queue"
```

---

### Task 5: Popup paste flow — playlist branch

**Files:**

- Modify: `src/popup/popup_url_events.ts`
- Test: `tests/js/popup/playlist_expand.test.ts` (create)

**Interfaces:**

- Consumes: `PopupApi.enumeratePlaylist` (Task 3), existing `getFormatsForUrl` single flow.
- Produces: pasted playlist URL → rows + downloads view; single URLs unchanged — Task 6 consumes the rows.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

// Import prefix from tests/js/popup/ is ../../../src/ (mirrors media_list.test.ts).
vi.mock("../../../src/shared/popup_api.js", () => ({
  enumeratePlaylist: vi.fn(),
  getFormatsForUrl: vi.fn(),
  downloadVideo: vi.fn(),
  saveSettings: vi.fn(async () => ({})),
}));

describe("resolvePastedUrl playlist branch", () => {
  it("expands a playlist to rows and skips the quality dialog", async () => {
    const api = await import("../../../src/shared/popup_api.js");
    vi.mocked(api.enumeratePlaylist).mockResolvedValue({
      ok: true,
      videoIds: ["v1", "v2"],
      playlistTitle: "My Mix",
      totalItems: 2,
    } as never);
    const { resolvePastedUrl } = await import("../../../src/popup/popup_url_events.js");
    const opened = await resolvePastedUrl("https://open.spotify.com/playlist/abc123");
    expect(opened).toBe(true);
    expect(api.getFormatsForUrl).not.toHaveBeenCalled();
  });

  it("falls back to single-URL flow on the single-track sentinel", async () => {
    const api = await import("../../../src/shared/popup_api.js");
    vi.mocked(api.enumeratePlaylist).mockResolvedValue({ ok: false, error: "__QWIN_SINGLE_TRACK__" } as never);
    vi.mocked(api.getFormatsForUrl).mockResolvedValue({ ok: true, videoId: "v9", formats: [] } as never);
    const { resolvePastedUrl } = await import("../../../src/popup/popup_url_events.js");
    await resolvePastedUrl("https://open.spotify.com/track/abc123");
    expect(api.getFormatsForUrl).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/popup/playlist_expand.test.ts`
Expected: FAIL — `enumeratePlaylist` is not a function (real `popup_api.ts` has no such export yet, mock aside the `resolvePastedUrl` implementation never calls it).

- [ ] **Step 3: Write minimal implementation**

In `resolvePastedUrl`, after `setNotice("")` and before the `getFormatsForUrl` call:

```ts
const playlist = (await PopupApi.enumeratePlaylist(activeTabIdOrZero(), url)) as
  | (FormatsResponse & { videoIds?: string[]; playlistTitle?: string; totalItems?: number })
  | null;

if (playlist && playlist.ok && playlist.videoIds?.length) {
  hideQualityDialog();
  setNotice(`Added ${playlist.videoIds.length} tracks from ${playlist.playlistTitle || "playlist"}.`);
  setViewMode("downloads");
  await refresh();
  return true;
}
if (playlist && !playlist.ok && playlist.error && !String(playlist.error).includes("__QWIN_SINGLE_TRACK__")) {
  hideQualityDialog();
  setNotice(playlist.error, true);
  return false;
}
// Single track (sentinel) or unexpected shape: fall through to the existing single-URL flow.
```

`MessageResult` needs an `error` read — follow the existing `asRecord` pattern used in `popup/downloads/state.ts` (`errorText`-style narrowing), not a cast that drops it. Keep the rest of the function byte-identical.

Bulk quality is the default (`best`): no quality dialog for playlists — the dialog only opens on the single-URL path below. Per-track picker is explicitly out (spec).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/popup/playlist_expand.test.ts; if ($?) { npm run typecheck }`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/popup/popup_url_events.ts tests/js/popup/playlist_expand.test.ts
git commit -m "feat(popup): expand pasted playlists into rows"
```

---

### Task 6: Selection-bar batch executor

**Files:**

- Modify: `src/popup/views/PopupFrame.tsx`
- Modify: `src/popup/views/SelectionBar.tsx`
- Test: extend `tests/js/popup/playlist_expand.test.ts`

**Interfaces:**

- Consumes: `orderedSelection` from `ui/useStickySelection.ts`, `PopupApi.downloadMany`, `activeTabIdOrZero` pattern.
- Produces: working "Download N" button — the screenshot's Retry/Remove rows stay per-row and untouched.

- [ ] **Step 1: Write the failing test**

```ts
it("batch executor calls downloadMany with the ordered selection", async () => {
  const api = await import("../../../src/shared/popup_api.js");
  vi.mocked(
    api.downloadMany ??
      (() => {
        throw new Error("no downloadMany");
      }),
  ).mockResolvedValue?.({ ok: true, jobIds: ["j1", "j2"] } as never);
  const { batchDownloadSelection } = await import("../../../src/popup/views/PopupFrame.js");
  const reply = await batchDownloadSelection(7, ["v1", "v2"], "best");
  expect(reply.jobIds).toHaveLength(2);
});
```

`batchDownloadSelection(tabId, ids, formatId)` is the new exported helper in `PopupFrame.tsx` (exported for test; the button calls it with live signals).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/popup/playlist_expand.test.ts -t "batch executor"`
Expected: FAIL with "no downloadMany" / "does not provide an export named 'batchDownloadSelection'".

- [ ] **Step 3: Write minimal implementation**

`PopupFrame.tsx` — replace `function batchDownloadStub(): void {}` with:

```tsx
export async function batchDownloadSelection(tabId: number, ids: string[], formatId = "best") {
  const { downloadMany } = await import("../../shared/popup_api.js");
  const reply = (await downloadMany(tabId, ids, formatId)) as {
    ok?: boolean;
    jobIds?: string[];
    error?: string;
  } | null;
  if (!reply || !reply.ok) {
    throw new Error(reply?.error || "Batch download failed to start.");
  }
  clearSelection();
  setViewMode("downloads");
  return reply;
}
```

Wire the existing button's `onDownloadAll` prop to `() => void batchDownloadSelection(activeTabIdOrZero(), orderedSelection.value, "best").catch((error) => setNotice(...))` following the file's existing notice pattern; keep the static import of `downloadMany` if the file already imports `PopupApi` statically (match surrounding style — dynamic import above is only to keep the test seam; prefer the file's existing convention).

`SelectionBar.tsx` — delete `BATCH_PENDING_REASON` and the `disabled` + reason copy on the primary button; it is now live. If an `onDownloadAll` prop already exists (it does — `SelectionBarProps.onDownloadAll`), the change is "remove one attribute", exactly as the prop docstring predicts.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/popup/; if ($?) { npm run typecheck }; if ($?) { npm run lint }`
Expected: PASS all popup tests, clean typecheck and lint.

- [ ] **Step 5: Commit**

```bash
git add src/popup/views/PopupFrame.tsx src/popup/views/SelectionBar.tsx tests/js/popup/playlist_expand.test.ts
git commit -m "feat(popup): enable selection-bar batch download"
```

---

### Task 7: Gates + regression sweep

**Files:** none (verification only).

- [ ] **Step 1: Run the four gates**

```powershell
npm run lint; if ($?) { npm run typecheck }; if ($?) { npm test }; if ($?) { npm run test:native }
```

Expected: all green — 1118+ vitest tests across 31+ files, 9+ pytest files.

- [ ] **Step 2: Build (Windows fifth gate)**

```powershell
npm run build
```

Expected: `dist/chromium/` and `dist/yandex/` rebuild; baseline stays near 23 files / 610 KB (`dist/yandex`).

- [ ] **Step 3: Manual verification (Yandex first, ext id `dbjddokdmkodnkiaccmbjagfalmmmkmi`)**

  - Paste the screenshot's Spotify playlist URL: rows expand, no "only individual tracks" error.
  - YouTube playlist + direct MP4 page enumerate.
  - Start 5+ tracks: exactly 3 run, rest `Queued #n`, promote on finish.
  - Pause / cancel / retry one track; siblings unaffected.
  - Failing track shows per-row Retry/Remove; rest complete.
  - Theme System/Light/Dark + resize rubber-band + `/` search + arrows unaffected.

- [ ] **Step 4: Commit nothing (or `docs:` touch-up)**

If verification exposed doc drift in `AGENTS.md` (structure table, test counts), amend in a `docs:` commit. Otherwise no commit — mark done.

---

## Self-review

- Spec coverage: collection parse + cap (§4 caps) → Task 1; `enumeratePlaylist` Spotify branch (§1) → Task 2; expand-to-rows + `groupId` (§3) → Tasks 3+5; 3-queue reusing `startNativeDownloadFromVideo` + provenance-only `tabId` (§2) → Task 4; executor replacing stub + dropping `BATCH_PENDING_REASON` (§3) → Task 6; per-row failure isolation (§4) → Task 4 test; `test_host_imports.py` green → Tasks 1+2 run it; gates + Yandex manual (§5) → Task 7. Bulk `best` default and explicit outs (per-track picker, configurable concurrency, virtualization) respected throughout.
- Placeholder scan: no TBD/TODO; every step has exact code, exact commands, exact expected output. Task 2's test evolution is written out (scaffolding replaced by the final version in the same step — implement the final version).
- Type consistency: `enumeratePlaylistVideos`/`createBoundedQueue`/`batchDownloadSelection` signatures match across tasks; `playlistItems` wire shape (`playlistTitle/items/totalItems`) identical in Tasks 1–3; `MessageOf<>` keys match the `contracts.ts` additions.
