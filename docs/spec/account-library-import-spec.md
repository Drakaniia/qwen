# Account Library Import — spec

**Status:** drafted 2026-10-06 from a five-round interview. No code written yet. This file is the
contract for the implementation; treat it the way `AGENTS.md` treats `ui-ux-redesign-spec.md` —
when this file and the tree disagree, the tree wins and this file gets fixed.

**Short name:** account library import. **Spec file:** `account-library-import-spec.md`.

**One-line answer to the request.** Yes — but _not_ by adding a Google/Spotify login to Qwin. The
browser profile is already logged in, and this extension already holds the `cookies` permission and
already knows how to turn a cookie jar into something yt-dlp can use. The feature is therefore
"read the library of the account this browser is already signed into, land it as rows, and let the
existing selection + `downloadMany` machinery download it" — with no OAuth client, no third-party
consent screen, and no new login UI.

---

## 1. The request, and what it resolves to

> "can we integrate it to login with google to fetch playlist or spotify login? to download all
> liked music?"

Three sub-questions hide in that sentence, and each has a different answer:

| Sub-question               | Answer                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Login with Google"        | No new login. Cookie-based reuse of the browser's existing Google/YouTube session. A real OAuth flow needs a registered Google Cloud client + a consent screen + a Chromium-fork-dependent `chrome.identity` path, and it buys nothing the cookie jar does not already give us. See §3.1. |
| "Login with Spotify"       | Same: reuse the `sp_dc` web-player session. Spotify's private library is only reachable through undocumented web-player endpoints, so this path is explicitly best-effort (§3.3).                                                                                                         |
| "Download all liked music" | Yes, but the import lands **rows**, not a fire-and-forget batch (interview decision, §2). Selection + `downloadMany` already exist and are 3-concurrent and queue-gated.                                                                                                                  |

---

## 2. Decisions from the interview

Each row is a decision the implementation must honour. These are not suggestions.

| #   | Question                  | Decision                                                                                                                          | Consequence                                                                                                                                                                   |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Which libraries           | **Both providers**, and the wider net: YouTube liked + Watch Later, Spotify liked songs + saved albums (+ own playlists if cheap) | Source registry with several named sources, not one hard-coded list (§5.1)                                                                                                    |
| D2  | Auth method               | **Reuse the existing browser session (cookies)**                                                                                  | No OAuth, no `identity` permission, no client IDs in the manifest. Works in Yandex today.                                                                                     |
| D3  | Which "liked"             | **Whichever is reachable; the exact list id is an implementation detail**                                                         | Try `LM` (YouTube Music liked songs) first, fall back to `LL` (YouTube liked videos). Both are ordinary yt-dlp playlist URLs.                                                 |
| D4  | Library size              | **Everything, paged until done**                                                                                                  | The Spotify `PLAYLIST_ITEM_LIMIT = 100` cap does not apply to this path. Progress + cancel required.                                                                          |
| D5  | Entry point               | **Popup, Media tab, beside the paste box**                                                                                        | A library button in the `PasteBox` row in `MediaView`; the import sheet is a popup `Sheet`, never the overlay's dialog.                                                       |
| D6  | After import              | **Rows only; the user selects and downloads**                                                                                     | No auto-start, no "download all" button. The import's job ends when the rows exist.                                                                                           |
| D7  | Already-downloaded items  | **Skip anything already downloaded**, keyed on a **persistent set of imported item ids** in `storage.local`                       | New storage key, never pruned to 200 like job records (§5.5)                                                                                                                  |
| D8  | Row model                 | **Lightweight rows, resolve on download**                                                                                         | Library rows carry id/title/artist/art only. The Spotify→YouTube match and the format enumeration still happen at download time, exactly as `spotify_fallback.py` does today. |
| D9  | Spotify's private library | **Accept the fragility; best-effort with a clear error**                                                                          | A typed failure (`LIBRARY_SOURCE_CHANGED`) surfaces as "Spotify changed its response — update needed", never a crash or an "Unexpected helper error".                         |
| D10 | Persistence               | **Stateless; re-fetch each import**                                                                                               | No last-synced timestamp, no diff, no cached library. The only persisted thing is D7's id set.                                                                                |
| D11 | Non-music in `LL`         | **Drop obvious non-music (very long videos)**                                                                                     | A duration filter on import, with the threshold as a named constant (§5.6, open question Q3).                                                                                 |
| D12 | Signed out / expired      | **Inline notice in the import sheet, with an "Open YouTube/Spotify" action**                                                      | Not the `DependencyBanner`, not a disabled button — the sheet itself explains and offers the fix                                                                              |
| D13 | Unavailable items         | **Keep the row, mark it unavailable**                                                                                             | Truthful count; the row is visible but not selectable, or selects into a per-row error                                                                                        |
| D14 | Cookie plumbing           | **A dedicated, larger, auth-aware cookie set for the library path**                                                               | Do not reuse the 4096-byte path-length-sorted header (§5.2)                                                                                                                   |
| D15 | Pacing                    | **Page as fast as needed, cancelable**                                                                                            | `342 of 1,204` progress + a working Cancel; no artificial sleeps                                                                                                              |
| D16 | Default audio format      | **Best audio, container as-is (Opus/M4A)**                                                                                        | Library downloads do **not** go through the mp3 re-encode chain; `--extract-audio` is not added by default                                                                    |
| D17 | Write-back                | **Strictly read-only**                                                                                                            | Qwin never likes, unlikes, edits a playlist, or clears Watch Later                                                                                                            |
| D18 | Phasing                   | **Google/YouTube first (Phase 1), Spotify second (Phase 2)**                                                                      | Phase 1 depends only on the cookie path that already ships; Phase 2 adds the undocumented endpoints behind the same interface                                                 |
| D19 | Verification              | **Unit-test the boundary; manual signed-in Yandex pass for the live paths**                                                       | vitest + pytest against faked replies; a numbered manual script in §9.2                                                                                                       |

Deliberately **not** chosen, and recorded so nobody re-litigates them: a real OAuth flow (D2), an
Options "max items" setting (D4), a "download everything now" confirm dialog (D6), and
`--cookies-from-browser` in the host (D2 — the extension owns the cookie jar, the host must not
guess which browser profile is running).

---

## 3. Findings that shaped the design

Grounded in the tree as of 2026-10-06.

### 3.1 There is no OAuth anywhere, and there does not need to be

- No `identity` permission and no `identity`/`oauth2`/`getAuthToken`/`launchWebAuthFlow` call site
  exists in `src/`. `config/extension/manifest.chromium.json` grants
  `activeTab, scripting, downloads, storage, webRequest, nativeMessaging, tabs, cookies`.
- `chrome.identity.getAuthToken` is profile-bound and Chrome-specific: it needs an `oauth2` manifest
  section plus a registered client id, it signs in the _Chrome profile_ rather than offering a
  normal account picker, and it is widely reported not to work in Chromium forks such as Yandex
  Browser — this project's **primary browser** per `AGENTS.md`. Reports vary by fork and version, so
  treat "it does not work in Yandex" as **to be verified manually before relying on it**
  (§9.2 step 1 can confirm whether `browserApi.identity` even exists there). Even where it works, it
  is the wrong tool: it asks the user to authenticate to Google to read a session the browser
  already holds.
- `chrome.identity.launchWebAuthFlow` would work in any Chromium fork and reach
  `https://<extension-id>.chromiumapp.org/*` — and the extension id is already pinned
  (`dbjddokdmkodnkiaccmbjagfalmmmkmi`), so a redirect URI could be pre-registered. But it still
  needs a Google Cloud project and a Spotify app owned by whoever ships this, plus a consent screen
  the user must complete. That is a _worse_ user experience than "you are already signed in", and
  it is the same data.
- The cookie path is not a workaround here; it is the established approach for this exact job.
  `yt-dlp --cookies <file> --flat-playlist "https://www.youtube.com/playlist?list=LL"` is the
  documented way to enumerate a personal liked list.

**Consequence:** the word "login" disappears from the feature. There is a _connection status_
("Signed in as …" / "Not signed in") and an action that opens the site in a tab, and that is all.

### 3.2 The cookie plumbing already exists — it is just private and too small

`src/background/header_utils.ts`:

- `cookieHeaderForUrl(url)` (~line 158) already builds a `name=value; …` cookie header for an
  arbitrary URL via `browserApi.cookies.getAll({ url })`. It is **module-private**.
- It sorts cookies by _path length descending_ and truncates at `MAX_COOKIE_HEADER_LENGTH = 4096`
  (~line 43), cutting at the last complete cookie boundary. That truncation is tuned for "get past a
  bot wall on a media URL", not for authentication: the important Google auth cookies
  (`SID`, `HSID`, `SSID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `LOGIN_INFO`) have no
  relationship to path length and can be the ones dropped.
- `nativeRequestHeadersForVideo(videoUrl, pageUrl)` (~line 186) is the exported wrapper that adds
  `Cookie` plus `Referer`/`Origin`/`Accept` into the `RequestHeader[]` the host consumes.

`src/native_host/system/browser_context.py`:

- `write_cookie_file_from_headers(url, request_headers, temp_dir=None)` (line 127) — the existing
  bridge from a `requestHeaders` array to a Netscape `qwin-cookies-*.txt`.
- `write_cookie_file_from_string(cookie_str, url, temp_dir=None)` (line 146) — a raw cookie header,
  no `requestHeaders` array needed.
- `remove_temp_files(paths)` (line 136) — the existing teardown.
- `src/native_host/download/log_utils.py` redacts `qwin-cookies-*.txt` filenames from logs.

**Consequence:** Phase 1 is an _export + widen_ of code that exists, not new plumbing (§5.2).

### 3.3 Spotify's private library is the fragile half

`src/native_host/backends/spotify/spotify_metadata.py` reads the **public embed page**:
`https://open.spotify.com/embed/{kind}/{id}` → `__NEXT_DATA__` → `entity.trackList`, capped at
`PLAYLIST_ITEM_LIMIT = 100`, with per-track cover upgrades through `open.spotify.com/oembed`.
That works because a _public_ playlist/album is public.

Liked Songs is not a playlist and is not public. The only credential-free-looking route is the web
player's own token endpoint (`open.spotify.com/get_access_token`, feed the `sp_dc` cookie, receive a
web-player access token) and then `GET https://api.spotify.com/v1/me/tracks` (scope
`user-library-read`). That endpoint has required a TOTP code since 2025, where the secret is
extracted from the web player's own JavaScript bundle and rotates when Spotify rotates it —
upstream libraries maintain separate "secrets" packages for exactly this reason, and they break
whenever Spotify rotates. `resolve_spotify_formats` already documents the DRM wall that forces this
whole fallback chain to exist.

**Consequence:** two facts drive the design. (a) Expect to fix this file periodically; (b) put the
source behind an interface so a broken Spotify cannot take the Google path down with it (D9, D18).
The **host-side** implementation should be written to try, in order:

1. `GET https://api.spotify.com/v1/me/tracks?limit=50&offset=N` with a web-player token obtained via
   `sp_dc` + TOTP. Preferred: paginated JSON, real `total`, per-track art and duration.
2. The web player's internal GraphQL/`pathfinder` query for the library view, if (1) is blocked.
3. Fail with `LIBRARY_SOURCE_CHANGED`.

Optionally, a fourth fallback the implementer may pick _instead of_ implementing TOTP in Python:
drive the request from the extension (MV3 `fetch` carries cookies for a host with
`host_permissions`, and `<all_urls>` is granted), so the token endpoint is called from the browser
context that already has whatever the web player needs, and the resulting token or track list is
handed to the host. This is recorded as **Open question Q1** — pick one, do not do both.

### 3.4 yt-dlp's cookie-driven library URLs

| Source id             | URL yt-dlp is pointed at                     | Notes                                                        |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `youtube_music:liked` | `https://music.youtube.com/playlist?list=LM` | Music-only, audio-first. Try first (D3).                     |
| `youtube:liked`       | `https://www.youtube.com/playlist?list=LL`   | Whole liked list, includes non-music → duration filter (D11) |
| `youtube:watch_later` | `https://www.youtube.com/playlist?list=WL`   | Watch Later                                                  |

Two known limitations the spec must state rather than pretend away:

- Enumerating `LL`/`WL` historically returns **fewer entries than the site displays** — it is a
  known upstream yt-dlp limitation, not a bug in this code. The import reports the count it got;
  it cannot know what is missing.
- `LL`/`WL` require the Google session. Without cookies yt-dlp returns an empty or sign-in-gated
  result, which is exactly the D12 case, and must be detected as _signed out_ rather than _empty
  library_.

### 3.5 The plumbing a full-library import leans on

- `src/background/playlist_helpers.ts:enumeratePlaylistVideos` is the shape to copy: it calls
  `ctx.nativeRequest({ type: "enumeratePlaylist", … }, ENUMERATE_TIMEOUT_MS = 90000)`, then calls
  `ctx.addDetectedVideo` once per item, stamping `playlistId` / `playlistTitle` /
  `playlistThumbnailUrl`. The comment there is load-bearing: **`playlistId` is the playlist URL
  itself, and it is deliberately not `groupId`.**
- `src/native_host/backends/format_list.py:@register_handler("enumeratePlaylist")` (line 206) is
  the single host entry point: a Spotify URL short-circuits to `resolve_spotify_playlist`; everything
  else goes through `build_flat_playlist_command` with `timeout=60`, then a best-effort
  `_playlist_cover` probe. `isCollection` in the reply is the only trustworthy "was this really a
  list?" signal (a one-entry result from an ordinary video URL must not be read as a small playlist).
- `src/background/native_requests.ts:nativeRequest` opens a **new host process per request** via
  `connectNative`, resolves on the first matching-id non-error reply, and disconnects. It ignores
  extra messages. There is no streaming variant yet — see §5.4 and §6.2.
- `src/background/download/index.ts` has `MAX_CONCURRENT_DOWNLOADS = 3` and `downloadMany(tabId,
videoIds, formatId)`; `src/background/download/queue.ts`'s `createBoundedQueue` holds a slot until
  the job _settles_, precisely because a 100-item playlist otherwise opened 100 native ports.
- The Media list is **not virtualized**, deliberately. This is the single biggest risk in D4/D8 and
  is addressed in §5.7.

---

## 4. Scope

### In scope

- A connection-status notion per provider, derived from the cookie jar (no new login UI).
- A source registry: YouTube Music liked, YouTube liked, YouTube Watch Later, Spotify liked songs,
  Spotify saved albums, Spotify own playlists.
- Full paged enumeration with live progress and a working cancel.
- Lightweight rows landed into the tab's video list, folded into a playlist folder by the existing
  `mediaRows` / `playlistId` machinery.
- A persistent skip-list of imported item ids.
- Phase 1 = Google/YouTube (cookie-only). Phase 2 = Spotify (best-effort, undocumented endpoints).

### Out of scope

- Any OAuth flow, `identity` permission, client id, or consent screen (D2).
- Any write to the account: like, unlike, add/remove playlist entries, clear Watch Later (D17).
- Auto-starting downloads, "download all" buttons, or a batch confirm dialog (D6).
- Remembering the library, last-sync time, or a new-since diff (D10).
- Playlist/album enumeration for arbitrary _public_ URLs — that is `enumeratePlaylist` today and does
  not change.
- Playback, streaming, or DRM anything.

---

## 5. Design

### 5.1 Sources and connection status

A source is a named, addressable library. Vocabulary (single source of truth, exported from
`src/shared/contracts.ts` and mirrored in Python):

```ts
export type LibraryProvider = "youtube" | "youtube_music" | "spotify";
export type LibrarySourceId =
  | "youtube:liked"
  | "youtube:watch_later"
  | "youtube_music:liked"
  | "spotify:liked"
  | "spotify:albums"
  | "spotify:playlists";
```

Each source declares: `id`, `provider`, `label` ("Liked songs", "Watch Later", "Saved albums"),
`phase` (1 or 2), and `availability` (`"ready" | "signed_out" | "unavailable"`). Availability is
computed **in the extension**, from the cookie jar, not by asking the host — the sheet must be able
to render "Not signed in to YouTube" without a helper round trip, and the helper may not even be
running.

Phase 1 ships the three YouTube sources; Phase 2 adds the three Spotify ones. The sheet renders the
whole table, so a Phase-2 source that is unwired is simply absent from `librarySources` rather than
greyed out and confusing.

### 5.2 Cookie collection (the only security-relevant surface)

Add to `src/background/header_utils.ts`, beside the existing private helper:

- **Export** `cookieHeaderForUrl` (or add `libraryCookieHeaderFor(urls: string[])`) so a caller can
  build a cookie header without inventing a fake "video URL".
- **A new, separate cookie-set builder for the library path.** It must:
  - accept a _list_ of URLs and merge, because a YouTube library needs cookies for
    `https://www.youtube.com/`, `https://music.youtube.com/` and `https://www.google.com/` — the
    Google auth cookies live on `.google.com` and `cookies.getAll({ url: "https://www.youtube.com/…" })`
    does not return them;
  - **order by a known-names priority list**, not by path length, so the auth cookies survive
    truncation. Proposed priority (case-sensitive as sent):
    `SID, HSID, SSID, SAPISID, __Secure-1PSID, __Secure-3PSID, __Secure-1PSIDTS, __Secure-3PSIDTS,
LOGIN_INFO, APISID, __Secure-1PAPISID, __Secure-3PAPISID, sp_dc, sp_key, sp_t,`,
    then everything else in its existing path-length order;
  - keep a **larger** cap than `MAX_COOKIE_HEADER_LENGTH` — a new
    `MAX_LIBRARY_COOKIE_HEADER_LENGTH = 8192` constant with a comment saying why the two numbers
    differ. Do not raise the shared 4096 constant: that budget was tuned against YouTube's 413
    behaviour on plain media requests and changing it is a behaviour change for every download.
- Never log the header. The host already redacts temp cookie _filenames_; the header itself must
  never reach `downloads.jsonl` or stdout.
- The header rides on the native message as the existing `requestHeaders` array (one `Cookie`
  entry), so `write_cookie_file_from_headers` / `write_cookie_file_from_string` do the writing and
  `remove_temp_files` does the cleanup. **No new file format, no new temp-file prefix.**

### 5.3 Phase 1 — the YouTube source (cookie-only, low risk)

The implementer should reuse the existing enumeration command builder rather than write a new one:
`build_flat_playlist_command` in `src/native_host/backends/yt_dlp/yt_dlp_command.py` already takes
`request_headers` / `cookies_file` / `referer` / `headers_config_path`. A library source is
"`enumeratePlaylist` with a fixed URL, a different timeout, and a music filter".

Differences from `enumeratePlaylist` that must be implemented:

| Concern        | `enumeratePlaylist` today                         | Library path                                                                                                                                                 |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Timeout        | `subprocess.run(…, timeout=60)`, TS side 90 s     | Must accommodate thousands of entries: raise the subprocess timeout (proposal: 300 s) and the TS side accordingly (proposal: 600 s), both as named constants |
| Cap            | none (all flat entries)                           | none (D4) — but progress must be streamed so a long run looks alive                                                                                          |
| Music filter   | none                                              | D11 duration filter                                                                                                                                          |
| `isCollection` | computed for the caller to gate the quality sheet | always `true` by construction; the sheet is never used for an import                                                                                         |
| Folder cover   | best-effort `_playlist_cover` probe               | reuse it; the probe already exists and is `ponytail:`-marked                                                                                                 |

`LM` before `LL` (D3): probe `LM` first, and if it yields nothing usable, retry `LL`. Report which
one produced the rows in `playlistTitle` ("Liked songs" vs "Liked videos") so the folder is honest.

### 5.4 Phase 2 — the Spotify source

`src/native_host/backends/spotify/` gains one module per concern, matching the existing layout
(`spotify_metadata.py` / `spotify_resolver.py` / `spotify_youtube.py` are the precedent):

- `spotify_library.py` — token acquisition (`sp_dc` + TOTP), then `me/tracks`, `me/albums`,
  `me/playlists`, paged 50 at a time with the offset loop.
- Reuse `apply_track_covers`' contract (it mutates camelCase `thumbnailUrl` /
  `thumbnailCandidates` per row — the keys the wire reply and the popup actually read).
- Raise a **typed** `HostError` with a machine-readable prefix for the changed-response case, the
  way `resolve_spotify_formats` already raises `__QWIN_SINGLE_TRACK__` — a sentinel the extension
  turns into a specific message rather than the generic "Unexpected helper error" (D9).
- The per-track YouTube search stays **out of enumeration** (D8): rows are metadata only; the
  existing `search_youtube` + `build_youtube_download_command` run at download time, which is what
  `run_spotify_fallback_download` already does.

A kill-switch is **not** in scope (it was offered in D18 and not chosen); Phase 2 is simply the
later commit, and a broken Spotify path fails per-source.

### 5.5 Skip-list — the persistent imported-item set (D7)

- New `storage.local` key: `qwinLibraryImportedIds` (name follows `qwinSettings` /
  `qwinDownloadsById`).
- Contents: `{ ids: string[], updatedAt: number }`, `ids` newest-first, capped at a named
  `LIBRARY_IMPORTED_ID_LIMIT` (proposal: 5000). Pruning the oldest tail is required; an unbounded
  array in `storage.local` is a defect.
- The id written per item is the **source's own item id** (the YouTube video id / Spotify track id),
  not the row id and not the URL. It must be prefixed by provider so a YouTube id and a Spotify id
  can never collide: `youtube:<videoId>`, `spotify:<trackId>`.
- Read path: the extension filters the enumerated list before creating rows, then reports the
  skipped count in the sheet's completion line ("1,204 items · 12 already downloaded").
- **Which ids get written**: an item is added to the set when it is _imported_ (D7 chose
  "imported item ids", not "downloaded item ids") — the interview's wording. The spec calls this out
  because it is the one place the decision is genuinely ambiguous (Q2): a row that is imported and
  never downloaded is skipped on the next import. If the intent was "already downloaded", the write
  moves to the download-completion path. **Implement the interview's literal reading** (on import)
  and flag the alternative in the sheet copy: the completion line says "already imported", not
  "already downloaded".

### 5.6 Music filter (D11)

- Constant `LIBRARY_MAX_DURATION_SECONDS` (proposal: 900 = 15 min), applied to flat-playlist
  `duration` at import time.
- Items with no duration (flat enumeration often omits it) are **kept** — dropping them would
  silently discard most of some lists.
- The filter applies only to `youtube:liked` / `youtube:watch_later`. `youtube_music:liked`,
  `spotify:liked`, `spotify:albums` are music by construction and are not filtered.
- Filtered items are counted and reported, not silently dropped ("· 87 long videos hidden").
- The constant gets a `ponytail:` note naming its deletion path, matching the codebase's convention
  for tunables with no UI.

### 5.7 Row model and the non-virtualized list (D8, the main risk)

Rows are lightweight: `url` (the source item URL), `title`, artist folded into the title or a
subtitle, `thumbnailUrl`/`thumbnailCandidates`, `duration` where known, and — critically — the ids
needed to (a) skip and (b) resolve later. They carry `playlistId` = the source URL, `playlistTitle`,
and `playlistThumbnailUrl`, exactly as `playlist_helpers.ts` stamps them, so the existing
`state/playlists.ts` folding and `PlaylistRow` rendering work unchanged.

Two constraints the implementer must respect:

1. **`areDistinctPlaylistEntries` must still hold.** Every library row shares one `playlistId` _and_
   one `pageUrl` (the library URL), and a YouTube library's rows are all
   `youtube.com/watch?v=<id>` — the exact shape that once collapsed a 61-track paste into one row.
   The guard in `src/shared/video_sorting.ts` compares `url`, and library rows have distinct `url`s,
   so it holds. **Do not delete that guard** and do not "simplify" it as redundant with `pageUrl`.
2. **A library import must be allowed to exceed the sizes the code has seen.** The list is not
   virtualized and there is no measured ceiling. Because D4 says everything and D6 says rows only,
   a 5,000-row import is reachable. Options, in order of preference:
   - (a) Land all rows and accept it (the honest reading of D4), with the `ponytail:` note in
     `VideoRow.tsx` updated to record the new worst case.
   - (b) Collapse the import into one **collapsed folder by default** (an unexpanded `PlaylistRow`
     renders one row, not N), expanding on click. This is nearly free: `expandedPlaylists` is
     already a signal and `mediaRows` already folds.
     The spec prefers (b) + (a): rows all exist, the folder starts collapsed, and the rendering cost
     is paid only when the user asks for it. This is an **Open question (Q4)** only in the sense of
     whether to also cap what the folder expands to.

Also: the rows belong to the **tab** that ran the import (videos are tab-scoped; downloads are
global — `AGENTS.md`). An import in tab A must not appear in tab B.

### 5.8 UI

**Trigger.** A library button in the paste-box row in `MediaView`
(`src/popup/components/PasteBox.tsx` renders the row; the button sits beside it, same height). New
icon name in `src/ui/Icon.tsx` following SF vocabulary — proposal `person.crop.circle`. Icons are
24×24 at `stroke-width: 1.6`; no emoji, no arbitrary values, no new colour tokens.

**The sheet.** New `src/popup/components/LibraryImportSheet.tsx`, mounted through
`src/ui/components/Sheet.tsx` (the popup may use `Sheet`; the _overlay_ may not — see the
anti-pattern note in `AGENTS.md`). Contents, in order:

1. **Connection line** per provider: "YouTube — signed in" / "Not signed in". Computed from the
   cookie jar (§5.1) with no helper round trip.
2. **Signed-out state** (D12): an inline explanation plus a button that calls
   `browserApi.tabs.create` on `https://www.youtube.com/` or `https://open.spotify.com/`, and a
   Retry. The sheet stays open. Never a disabled control with no explanation.
3. **Source list**: the Phase-1 sources as rows (label + item count once known), each with an
   Import action.
4. **Progress** (D15): `342 of 1,204` plus a Cancel button. `motion` presets only, from
   `src/ui/motion.ts`; durations in **seconds**; `prefers-reduced-motion` already handled by
   `theme.css`.
5. **Completion**: item count, skipped count, filtered count, unavailable count, and a note when a
   source was truncated by yt-dlp's own behaviour (§3.4).
6. **Failure**: the typed `LIBRARY_SOURCE_CHANGED` message rendered as plain language for Spotify,
   and the raw-but-mapped message for anything else.

Materials: the sheet is `.material-sheet`. Spacing on the 4/8/12/16/20/24 scale, radii from
{6,10,14,20,full}. An arbitrary Tailwind value is a defect.

### 5.9 Downloads (unchanged machinery)

Selection is `src/ui/useStickySelection.ts` + `SelectionBar`, dispatch is
`popup_api.downloadMany` → `message-handlers/download.ts` → `download/index.ts`'s 3-at-a-time
bounded queue. Nothing about that path changes. The only library-specific concern is D16: a library
row's format is **best audio, container as-is**, so the quality sheet is not opened for library rows
at all (the sheet is the `PlaylistRow`-suppressed case today: "a one-item result cannot be read as
small playlist without losing the quality sheet for every plain paste" — the inverse applies here,
the import never wants the sheet).

---

## 6. Interfaces

### 6.1 Message contract additions (`src/shared/contracts.ts`)

```ts
// popup -> background
export interface ImportLibraryMessage {
  source: LibrarySourceId;
}
// background -> popup (broadcast, same family as downloadUpdated)
export interface LibraryProgressEvent {
  type: "libraryProgress";
  requestId: string;
  fetched: number;
  /** Absent when the provider does not report a total (YouTube flat enumeration). */
  total?: number;
}
export interface LibraryDoneEvent {
  type: "libraryDone";
  requestId: string;
  ok: boolean;
  source: LibrarySourceId;
  playlistTitle?: string;
  totalItems?: number;
  imported?: number;
  skipped?: number;
  filtered?: number;
  unavailable?: number;
  error?: string;
}
```

`BackgroundMessage` gains `{ type: "importLibrary" } & ImportLibraryMessage` and
`{ type: "cancelLibraryImport"; requestId: string }`. `PopupEvent` gains the two events above.
Every addition is a type the code actually sends — the file's own header rule.

### 6.2 Native messages

| Direction  | Type               | Payload                                                     |
| ---------- | ------------------ | ----------------------------------------------------------- |
| ext → host | `enumerateLibrary` | `{ id, source, requestHeaders, userAgent }`                 |
| host → ext | `libraryProgress`  | `{ id, fetched, total? }` (zero or more)                    |
| host → ext | `libraryItems`     | `{ id, ok, playlistTitle, items[], totalItems, truncated }` |
| host → ext | `error`            | existing envelope; carries the typed library sentinel       |

`items[]` entries reuse the `enumeratePlaylist` item shape (`url`, `title`, optional
`thumbnailUrl`, `thumbnailCandidates`, `duration`), because `playlist_helpers.itemArtwork` already
knows how to read it and the artwork boundary rules (http(s) only, `data:` dropped, ladder capped by
`THUMBNAIL_CANDIDATE_LIMIT`) are enforced there.

**Streaming.** `nativeRequest` (`src/background/native_requests.ts`) ignores messages that are not
its terminal reply, so a paged import needs a sibling helper:

```ts
function nativeStream(
  api: ExtensionApi,
  hostName: string,
  payload: NativeRequestPayload,
  options: { onMessage?: (message: NativeResponse) => void; timeoutMs?: number },
): Promise<NativeResponse>;
```

Same connect/timeout/teardown as `nativeRequest`, with intermediate messages dispatched to
`onMessage` and resolution on the terminal message. **Cancel = `port.disconnect()`**: each request
is its own host process, so disconnecting closes stdin, the host's read loop sees EOF and returns
(§`host.py:main`). This is why D15's cancel works without a cancel message type at the host.

### 6.3 Host modules

```
src/native_host/library/
├── __init__.py
├── library_sources.py       # the registry: id -> table row, and the dispatch
├── library_youtube.py       # LM / LL / WL via build_flat_playlist_command
└── library_spotify.py       # me/tracks, me/albums, me/playlists (Phase 2)
```

One decorated entry point, `@register_handler("enumerateLibrary")`, in `library_sources.py`.
**`host.py` must import `library_sources`** — the import list in `host.py` is load-bearing
(it is what runs `@register_handler`), and `tests/native/test_host_imports.py` is the regression
guard that AST-scans for imports of local modules that no longer exist and asserts `handle_message`
routes to real callables. Adding the module without adding the import leaves a dead message type;
the test should be extended to cover `enumerateLibrary` the way it covers the existing types.

Python imports are flat (`host.py` walks `src/native_host/**` onto `sys.path`), so
`library_youtube.py` imports `from yt_dlp_command import …`, **not** `from backends.yt_dlp.…`.

### 6.4 Popup state

New `src/popup/state/library.ts`, following the existing signal modules:

```ts
export const librarySheetOpen = signal(false);
export const librarySources = signal<LibrarySource[]>([]);
export const libraryImport = signal<{
  requestId: string;
  source: LibrarySourceId;
  fetched: number;
  total?: number;
} | null>(null);
export const libraryResult = signal<LibraryDoneEvent | null>(null);
export const librarySkipIds = signal<ReadonlySet<string>>(new Set()); // hydrated once, written through the background
```

`qwinSettings` is owned in memory by `background/tab_state.ts` — **never** write `storage.local` for
settings directly. `qwinLibraryImportedIds` is _not_ a `Settings` field (it is a bounded cache, not
a preference), so it gets its own key and its own owner; still route the write through the
background so two popups cannot interleave a lost update.

---

## 7. Files to touch

**Phase 1 (Google/YouTube)**

| File                                                                    | Change                                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/background/header_utils.ts`                                        | Export the cookie-header builder; add the multi-URL, auth-priority, larger-cap library variant + `MAX_LIBRARY_COOKIE_HEADER_LENGTH` |
| `src/background/native_requests.ts`                                     | Add `nativeStream` beside `nativeRequest`                                                                                           |
| `src/background/library_helpers.ts`                                     | New — mirror of `playlist_helpers.ts`: source table, skip filter, enumeration → `addDetectedVideo`                                  |
| `src/background/message-handlers/library.ts`                            | New — `importLibrary`, `cancelLibraryImport`                                                                                        |
| `src/background/background.ts`                                          | Register the handler + the library-imported-id store                                                                                |
| `src/shared/contracts.ts`                                               | The types in §6.1, `LibrarySourceId`, `LibraryProvider`                                                                             |
| `src/shared/popup_api.ts`                                               | `importLibrary`, `cancelLibraryImport`                                                                                              |
| `src/popup/state/library.ts`                                            | New signals (§6.4)                                                                                                                  |
| `src/popup/state/app.ts`                                                | `librarySheetOpen` wiring, if it belongs with the other view state                                                                  |
| `src/popup/components/LibraryImportSheet.tsx`                           | New                                                                                                                                 |
| `src/popup/components/PasteBox.tsx` / `src/popup/views/MediaView.tsx`   | The trigger                                                                                                                         |
| `src/ui/Icon.tsx`                                                       | `person.crop.circle` (or the chosen name)                                                                                           |
| `src/popup/popup_background_events.ts`                                  | Route `libraryProgress` / `libraryDone`                                                                                             |
| `src/native_host/library/{__init__,library_sources,library_youtube}.py` | New                                                                                                                                 |
| `src/native_host/host.py`                                               | The load-bearing import                                                                                                             |
| `tests/js/background/library_helpers.test.ts`                           | New                                                                                                                                 |
| `tests/js/popup/library_sheet.test.tsx`                                 | New                                                                                                                                 |
| `tests/native/test_library_youtube.py`                                  | New                                                                                                                                 |
| `tests/native/test_host_imports.py`                                     | Extend to `enumerateLibrary`                                                                                                        |
| `AGENTS.md`                                                             | WHERE TO LOOK row + a NOTES entry once it lands                                                                                     |

**Phase 2 (Spotify)** — the same set plus
`src/native_host/library/library_spotify.py`, `tests/native/test_library_spotify.py`, and the
Phase-1 source table extended. No new TS surface.

`config/extension/manifest.chromium.json` is **unchanged**: `cookies` is already granted and
`identity` is deliberately not added.

---

## 8. Edge cases

| Case                                                         | Behaviour                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Not signed in to the provider                                | Sheet shows the D12 inline notice + open-site action; no host round trip                                       |
| Session expired mid-import                                   | Same notice on the failure path; the partial rows already landed stay (they are real rows)                     |
| Provider returns zero items                                  | "That library has no items" — distinct from the signed-out message. Empty is not an error.                     |
| `LM` empty, `LL` has items                                   | Silent fallback to `LL`, folder titled "Liked videos" (D3)                                                     |
| yt-dlp returns fewer entries than the site shows             | Accepted, documented (§3.4); the completion line reports the count received                                    |
| Every item filtered by duration                              | The import fails with "all items were filtered as long videos" rather than landing an empty folder             |
| Same item liked in both Spotify and YouTube                  | Two rows; the skip-list is provider-prefixed, so neither hides the other (§5.5)                                |
| Re-import of the same library                                | All items skipped, completion line says so, no rows added                                                      |
| A row imported in tab A, popup opened in tab B               | Tab B has no rows (videos are tab-scoped)                                                                      |
| Cancel during enumeration                                    | Port disconnect → host EOF → process exits; rows already added stay                                            |
| Nested playlist inside the library (Spotify "own playlists") | Not expanded — the playlist appears as one row. Expanding it is out of scope.                                  |
| Spotify changes its internal response                        | Typed `LIBRARY_SOURCE_CHANGED`, plain-language message, other sources unaffected                               |
| Helper not running                                           | Existing disconnected-helper state; the sheet's connection line still renders (it reads cookies, not the host) |
| A very large import (≥5,000 rows)                            | Folder starts collapsed (§5.7); `LIBRARY_IMPORTED_ID_LIMIT` prunes the oldest skip ids                         |
| Import while a download is running                           | Unaffected: `downloadMany`'s queue is per-download, the import is one enumeration                              |

---

## 9. Verification

### 9.1 Automated (D19)

- `tests/js/background/library_helpers.test.ts` — source table → ids; skip filtering with a
  hydrated set; provider-prefixed ids; duration filter (kept when absent); skip-id pruning at the
  cap; cookie header priority (auth names survive truncation, non-auth overflow is cut, order is
  stable); the streaming helper resolves on terminal and honours cancel.
- `tests/js/popup/library_sheet.test.tsx` — signed-in vs signed-out rendering, progress line,
  completion counts, typed-failure copy, cancel button.
- `tests/native/test_library_youtube.py` — `LM` → `LL` fallback; flat-playlist line parsing;
  duration filter; empty-library error; cookie temp files removed.
- `tests/native/test_library_spotify.py` (Phase 2) — offset paging, `total`, art keys are
  camelCase, `LIBRARY_SOURCE_CHANGED` on a drifted payload.
- `tests/native/test_host_imports.py` extended.

Everything above must run with no network and no account: fake the `nativeStream` reply in TS, fake
the HTTP/`subprocess` boundary in pytest.

### 9.2 Manual (Yandex first, then Chrome)

The gates (`npm run lint`, `typecheck`, `test`, `test:native`, `build`) plus this numbered script:

1. Sign in to YouTube in Yandex. Open the popup on any page → library button → sheet shows
   "YouTube — signed in".
2. Sign out (or use a clean profile) → the sheet shows Not signed in and the open-site action.
3. Import `youtube_music:liked` → rows land as one collapsed folder titled "Liked songs"; the
   completion line's count matches.
4. Import again → everything skipped, no duplicates, no second folder.
5. Long videos are absent from `youtube:liked` and the filtered count is reported.
6. Select 3 rows → Download → 3 jobs, correct titles, files open; the audio files are `.opus`/`.m4a`
   (no mp3 re-encode, D16).
7. Cancel mid-import on a large library → progress stops promptly, rows already landed remain.
8. Switch tab → the rows are not in the other tab's Media list.
9. Phase 2: sign in to Spotify → `spotify:liked` imports; on the day Spotify drifts, the failure is
   the plain-language message and YouTube still imports.

### 9.3 Not verifiable by the implementer

The live signed-in paths require the user's own accounts. Those are the user's steps; the spec does
not claim them as automated coverage.

---

## 10. Risks

| Risk                                                       | Likelihood     | Mitigation                                                                                                      |
| ---------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| Spotify's token/library endpoint drifts                    | High over time | Typed failure + per-source isolation (D9/D18); Phase 2 is separable                                             |
| Google truncates/rotates cookies such that auth is dropped | Medium         | Dedicated 8 KB auth-priority cookie set (D14); failure surfaces as signed-out, not as an empty library          |
| Non-virtualized list with thousands of rows                | Medium         | Folder starts collapsed; `ponytail:` note updated with the real worst case (§5.7)                               |
| yt-dlp enumeration of `LL`/`WL` returns a subset           | Certain-ish    | Documented, reported honestly, not "fixed"                                                                      |
| A 3,000-item import tempts a "download everything" reflex  | Low            | D6 is rows-only; the selection bar already shows the count before anything starts                               |
| Cookie headers reach a log                                 | Low            | No new logging; `log_utils` already redacts temp cookie names; the header is never written to `downloads.jsonl` |

---

## 11. Open questions

Answer these before coding the relevant part; each is genuinely undecided.

- **Q1 (Spotify transport).** Implement `get_access_token` + TOTP in Python, or drive it from the
  extension (MV3 `fetch` carries cookies for `<all_urls>`)? Pick one. Recommendation: the extension,
  since it reuses the browser's own session and keeps TOTP out of the host; the Python route is the
  fallback if the extension-side call is blocked.
- **Q2 (skip semantics).** D7 said "imported item ids"; the user-visible phrase was "already
  downloaded". §5.5 implements the literal decision and labels it "already imported". Confirm that
  is the intent, or move the write to download completion.
- **Q3 (music threshold).** `LIBRARY_MAX_DURATION_SECONDS = 900` (15 min) proposed. What is the
  right number for your library — music videos, live sets, DJ mixes?
- **Q4 (row ceiling).** Everything, or a `LIBRARY_IMPORT_ROW_LIMIT` for what actually lands as rows,
  with the folder summarizing the rest?
- **Q5 (folder default).** Should the import always land collapsed (preferred, §5.7) or expanded the
  way a small pasted playlist is today?
- **Q6 (source granularity).** Are Spotify _saved albums_ and _own playlists_ worth the extra
  paging and the "nested playlist is one row" wart in §8, or is Liked Songs enough for Phase 2?
- **Q7 (Watch Later).** Same question — it is three lines of work in Phase 1, but it is a very
  different kind of list (saved-for-later video, not music).

---

## 12. Phase plan

- **Phase 1 — Google/YouTube, cookie-only.** `header_utils` library cookie set, `nativeStream`,
  `library_helpers`, the host module + `host.py` import, source table with the three YouTube
  sources, skip-list, the sheet, tests. This phase has no undocumented dependency and delivers the
  user's headline ask ("download all liked music") for a YouTube/YouTube Music account.
- **Phase 2 — Spotify.** `library_spotify.py`, the three Spotify sources, typed failure, tests. No
  new TS surface; if Q1 chooses the extension transport, a small `background/spotify_token.ts`.
- **Phase 3 — optional, only if asked.** Write-back actions (D17 forbids them today), remembered
  sync + "new since last time" (D10 forbids it today), a `settings.ts` Options row.
