# Playlist parallel download — design

Date: 2026-10-05. Status: approved in chat, pending spec review.

## Problem

Pasting (or detecting) a playlist URL fails. Reported case (screenshot):
`open.spotify.com/playlist/57f9dQZF1E37gtLz…` renders an error row —
"Qwin can only resolve individual Spotify tracks, playlists are not yet
supported" — with Retry / Remove. Root cause:
`src/native_host/backends/spotify/spotify_resolver.py:38` rejects every
`content_type != "track"`, although `parse_spotify_url` already parses
`track|album|playlist|episode|show`.

Second gap: there is no batch executor. `src/ui/useStickySelection.ts`
deliberately dispatches nothing, `SelectionBar` shows the disabled
`BATCH_PENDING_REASON`, and `PopupFrame.tsx:batchDownloadStub` is empty.
One native port per job (`downloadPortsById[jobId]`) is parallel-capable,
but nothing queues or throttles N jobs.

## Decisions (user-confirmed)

- Scope: all playlists (Spotify + generic yt-dlp), one shared flow.
- UX: playlist expands to N selectable video rows, not a single playlist row.
- Concurrency: 3 simultaneous downloads, rest queued.

## Approach (A: expand in host, queue in background)

Rejected: B (one `--yes-playlist` yt-dlp job) — cannot fix Spotify, which
yt-dlp hard-blocks with `[DRM]`; C (popup loops `downloadVideo`) — queue
dies when the popup closes. Only the background outlives all surfaces.

## Changes

### 1. Native host — `src/native_host/`

- `backends/spotify/spotify_metadata.py`: add
  `fetch_spotify_playlist_tracks(collection_id, kind)` reading the same
  `__NEXT_DATA__` embed JSON (`/embed/playlist|album/{id}`), returning
  `[{artist, title, spotifyUrl}]`. Same `HostError` wording pattern on
  layout change.
- `backends/spotify/spotify_resolver.py`: add `resolve_spotify_playlist`
  returning `{playlistTitle, items}` capped at 100 (`PLAYLIST_ITEM_LIMIT`).
  Per-track items reuse the existing pipeline with metadata pre-filled
  (skip re-fetch, straight to `search_youtube`).
- `backends/spotify/spotify_youtube.py`: run per-track `search_youtube`
  under a 3-worker pool. Today one track costs up to 12 sequential
  `ytsearch` subprocess calls; 30 tracks sequential is ~360 probes.
- `backends/format_list.py`: `enumeratePlaylist` gains a Spotify branch —
  `is_spotify_url(url)` → `resolve_spotify_playlist`, else existing
  `--flat-playlist` path. Both send `playlistItems`.
- `host.py`: import the new module so `@register_handler` runs
  (`tests/native/test_host_imports.py` must stay green).

### 2. Background — `src/background/download/`

- New `downloadMany(tabId, videoIds, formatId)`: resolves each id via the
  existing video lookup, applies one quality choice to all (default
  `best`), starts up to 3 via `startNativeDownloadFromVideo`, rest stay
  `queued` with a `Queued #n` message and promote as ports free
  (`downloadPortsById` size is the active count). Reuses duplicate
  blocking, `videoFromDownloadJob`, `updateDownload` broadcasts.
- `tabId` stays provenance-only (global-downloads-spec §4); no tab filter
  on either read path. `message_router.ts` untouched (handler self-
  registers).

### 3. Popup — `src/popup/`

- `popup_url_events.ts:resolvePastedUrl`: after `enumeratePlaylist`,
  expand `items` to rows (`source: "playlist"`, `groupId` = playlist-URL
  hash, `pageUrl` = playlist URL so `sourceHostOf` chips stay correct).
- `views/PopupFrame.tsx`: replace `batchDownloadStub` with the executor
  walking `orderedSelection` → `downloadMany`; drop the
  `BATCH_PENDING_REASON` disabled state in `SelectionBar.tsx`.
- Per-row Retry/Remove (the screenshot's controls) keep working: one bad
  track fails, siblings continue.

### 4. Caps and errors

- `PLAYLIST_ITEM_LIMIT = 100` with a "first 100 of N" notice. The video
  list is deliberately unvirtualized (`VideoRow.tsx` `ponytail:` note), so
  an uncapped 1000-track playlist would choke rendering.
- Spotify embed-layout change → actionable `HostError`, same as the
  single-track path today. Generic `enumeratePlaylist` errors unchanged.

## Verification

- `pytest tests/native/`: embed-parse fixture, 100-cap, Spotify-branch
  dispatch, `test_host_imports.py` green.
- `vitest`: expand-to-rows, queue cap (3 active + rest queued), single
  failure doesn't cancel siblings, clear-finished keeps files.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:native`,
  `npm run build` (Windows fifth gate).
- Manual (Yandex first, ext id `dbjddokdmkodnkiaccmbjagfalmmmkmi`):
  Spotify playlist + YouTube playlist + direct MP4 enumerate; 3-at-once
  progress; pause/cancel/retry one track; theme + resize + keyboard
  unaffected.

## Explicitly out

Per-track quality picker, configurable concurrency in Options, list
virtualization. Add when a 100-track playlist measurably hurts.
