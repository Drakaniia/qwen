# Download backends

Qwin does not implement downloading. It enumerates candidate formats, probes which
installed tool can actually reach the URL, then hands the job to the winner. This page
is the reference for **which tools exist, what each one is for, and why the rest of
the ecosystem is not here.**

## The five tools

Reported by the native helper under these keys in the `pong` payload's `dependencies`
object. The machine-readable table lives in
[`src/shared/helper_dependencies.ts`](../../src/shared/helper_dependencies.ts); the Python
side is `dependency_status()` in [`src/native_host/host.py`](../../src/native_host/host.py).

| Key          | Tool        | Required | Role                                                                     |
| ------------ | ----------- | -------- | ------------------------------------------------------------------------ |
| `ytDlp`      | yt-dlp      | yes      | Format enumeration and the primary download path. 1000+ sites.           |
| `ffmpeg`     | ffmpeg      | yes      | Merges separate video/audio tracks, audio extraction, post-processing.   |
| `aria2c`     | aria2c      | yes      | Segmented parallel transfer. Speeds up large files. No format knowledge. |
| `nM3u8DlRe`  | N_m3u8DL-RE | no       | Preferred HLS/DASH/ISM downloader. Parallel segments, AES-128, live.     |
| `streamlink` | Streamlink  | no       | Live-stream fallback when a site needs a real player pipeline.           |

Two more are present but deliberately **not** in the table above:

- **`imageio-ffmpeg`** — a pip fallback for the ffmpeg _binary_. `resolve_ffmpeg_location()`
  uses it when no `ffmpeg` is on `PATH`, so it reports under `ffmpeg`.
- **`curl_cffi`** — TLS impersonation, installed as the `curl-cffi` extra of
  `yt-dlp[default,curl-cffi]`. yt-dlp uses it internally via
  `--extractor-args generic:impersonate`. It is not a downloader backend, has no probe, and
  is not a backend id anywhere. The standalone `curl_cffi_adapter.py` download backend was
  removed in `dad38be`.

### Install

```powershell
npm run setup    # scripts/install.sh via Git bash — installs all of the below
```

Individually:

```powershell
python -m pip install -U "yt-dlp[default,curl-cffi]" streamlink imageio-ffmpeg
winget install --id Gyan.FFmpeg -e        # ffmpeg binary
# aria2c.exe and N_m3u8DL-RE.exe land in tools/, fetched from GitHub releases
```

`yt-dlp[default]` pulls `brotli`, `certifi`, `websockets` and `mutagen`. Do not install
bare `yt-dlp` — several sites now require brotli and websockets.

### Licenses

Every tool above is free and open-source, fetched from its upstream source (PyPI, the
`Gyan.FFmpeg` winget package, or the project's own GitHub releases — see `scripts/install.sh`).
None of them is vendored into this repo and none carries a non-commercial clause, but they are
separate works under their own terms, and Qwin ships **no source for them**:

| Tool           | License                                           |
| -------------- | ------------------------------------------------- |
| yt-dlp         | Unlicense (public domain)                         |
| ffmpeg         | LGPL v2.1+, or GPL when built with `--enable-gpl` |
| aria2          | MIT                                               |
| N_m3u8DL-RE    | MIT                                               |
| Streamlink     | BSD-2-Clause                                      |
| imageio-ffmpeg | BSD-2-Clause                                      |
| curl_cffi      | MIT                                               |
| certifi        | MPL-2.0                                           |

The bundled extension itself is GPL-3.0-only (see `LICENSE`), which covers Qwin's own code
only. Read a tool's license before redistributing its binary.

## How a backend is chosen

`run_download` builds a list of probes and runs them all **in parallel**. Nothing is cancelled
when one of them succeeds; the winner is the **first probe in the list that reported
success**, so list order _is_ the priority order. `_build_probe_configs()` in
[`download_manager.py`](../../src/native_host/download/download_manager.py) emits the list,
and [`probe_runner.py`](../../src/native_host/probe/probe_runner.py) picks the winner.

| URL kind                                    | Probe order                       |
| ------------------------------------------- | --------------------------------- |
| Stream manifest (`.m3u8` / `.mpd` / `.ism`) | N_m3u8DL-RE → Streamlink → yt-dlp |
| Everything else                             | yt-dlp                            |

"Stream manifest" is decided by `is_stream_manifest_url()` in
[`stream_backends.py`](../../src/native_host/backends/stream_backends.py), which also honours
the request's `format` field. Stream manifests lead with N_m3u8DL-RE because it is
purpose-built for parallel segment fetching and handles malformed playlists and anti-leech
headers that plain ffmpeg chokes on; Streamlink sits behind it for live streams that need a
real player pipeline. yt-dlp is the only probe for everything else because its extractor
coverage is unmatched.

Two consequences of deciding the winner by index:

- The download starts once the probes have answered, not the instant the first one passes.
- **A probe failure does not mean the download would fail.** A probe runs a cheap
  reachability check — often yt-dlp in skip-download mode — which is not the same work as
  the real download command.

That second point is why a second tier exists. When no probe wins, a sequential fallback
chain runs instead, in order:

1. N_m3u8DL-RE, for stream manifest URLs
2. yt-dlp command variants
3. Streamlink, for stream manifest URLs
4. ffmpeg direct stream copy, for stream manifest URLs
5. yt-dlp with its native downloader, aria2c dropped

## Why nothing else is here

Every tool below was evaluated and rejected. Do not re-add one without a reason that
survives this list.

| Tool                               | Why not                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **lux** (ex-annie)                 | yt-dlp covers its sites with a larger extractor set and faster fixes.                                            |
| **you-get**                        | Same, plus weaker coverage of Chinese platforms than yt-dlp now has.                                             |
| **gallery-dl**                     | Image galleries only — a different media type, out of scope for a video downloader.                              |
| **gopeed**                         | A Go HTTP downloader with no format enumeration and no HLS/DASH support.                                         |
| **cobalt**                         | A web service, not a local CLI. Requires network round-trips we do not need.                                     |
| **youtube-dl**                     | Unmaintained. yt-dlp is its fork.                                                                                |
| **m3u8downloader**, **pydash2hls** | Strict-subset HLS tools. N_m3u8DL-RE handles more encodings and non-standard playlists.                          |
| **videofetch**                     | An aggregator whose own docs say its value is ffmpeg + N_m3u8DL-RE + aria2c — the three tools already installed. |
| **deno / node (JS runtime)**       | yt-dlp-ejs accepts node, which is already present. A dedicated runtime is not a downloader.                      |

Also permanently out of scope, and unrelated to tooling choice: magnet links and
`.torrent`, screen recording, and CDM / DRM capture. The lux / you-get / gallery-dl /
gopeed backends were deleted in `dad38be` / `f38e6de` / `8c5c698`.

## Adding a tool

1. Add one entry to `HELPER_DEPENDENCIES` in
   [`src/shared/helper_dependencies.ts`](../../src/shared/helper_dependencies.ts), and the
   matching key in `dependency_status()` in
   [`src/native_host/host.py`](../../src/native_host/host.py). Both UIs pick it up with no
   further edits.
2. Add a `probe_*` function in
   [`src/native_host/probe/probe_backends.py`](../../src/native_host/probe/probe_backends.py)
   and export it.
3. Add a resolver (+ `has_*` if it follows that convention) in
   [`yt_dlp_dependencies.py`](../../src/native_host/backends/yt_dlp/yt_dlp_dependencies.py),
   and a `build_*_command` in
   [`stream_backends.py`](../../src/native_host/backends/stream_backends.py).
4. Add a branch to `_build_probe_configs()` in
   [`src/native_host/download/download_manager.py`](../../src/native_host/download/download_manager.py)
   — **both** the probe entry and, if the tool is stream-only, the matching Tier 2 fallback
   entry. Position in that `if`-chain _is_ the priority order; there is no priority list to
   insert an id into any more.
5. Add the install step to `scripts/install.sh`.

The probe config table is the one remaining hardcoded piece. A follow-up moves probe and
fallback construction into a single backend table.
