"""Regression test: the probe backend table must match what the docs claim.

`docs/guides/downloaders.md` was written as a reference for the current system and
drifted. It documented a two-row priority list in `probe_runner.py` containing two
backend ids (`curl_cffi`, `ffmpeg`) no probe could ever produce, described a
"first success by priority" winner rule the code did not implement, and pointed its
"Adding a tool" recipe at a priority list that no longer exists. At the same time
`_build_probe_configs` gated every stream backend on a `requested_backend in {...}`
test no UI could satisfy, so the list it built was not the list anyone thought it was.

Spec D2/D3/D6 reconciled both sides; this test is the guard so the doc cannot drift
back. Precedent is `test_host_imports.py`, which AST-scans for dead handler routes --
same job, different subject: backend ids. A backend id that no probe produces (or no
`HELPER_DEPENDENCIES` entry backs) is documentation talking about a tool the download
path cannot reach.

No subprocess, no network, no monkeypatching: `_build_probe_configs` takes
already-resolved values as plain arguments, and its `probe_fn` fields are never
invoked here -- the assertions only read `config.backend`.
"""

import re
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_NATIVE_HOST = _REPO_ROOT / "src" / "native_host"
_PROBE_RUNNER = _NATIVE_HOST / "probe" / "probe_runner.py"
_HELPER_DEPENDENCIES_TS = _REPO_ROOT / "src" / "shared" / "helper_dependencies.ts"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in _NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        path = str(root)
        if path not in sys.path:
            sys.path.insert(0, path)


_add_native_host_to_path()

from probe_runner import ProbeResult  # noqa: E402

import download_manager  # noqa: E402
from yt_dlp_command import build_yt_dlp_fallback_variants  # noqa: E402


class _FakeTask:
    """Stand-in for `DownloadTask`: records the kwargs it was built with, runs nothing."""

    last = None

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        _FakeTask.last = self

    def start(self):
        return None


def _task_for_winner(winner):
    """The task `run_download` builds when `probe_runner_fn` names `winner`."""
    _FakeTask.last = None
    download_manager.run_download(
        {"id": "job-1", "url": "https://x.com/a.m3u8", "title": "Clip"},
        task_class=_FakeTask,
        yt_dlp_command_resolver=lambda: ["yt-dlp"],
        ffmpeg_location_resolver=lambda: "ffmpeg",
        aria2c_location_resolver=lambda: None,
        n_m3u8dl_re_location_resolver=lambda: "C:/tools/N_m3u8DL-RE.exe",
        streamlink_command_resolver=lambda: ["streamlink"],
        probe_runner_fn=lambda **_kwargs: ProbeResult(winner=winner, command=[winner], label=winner),
    )
    assert _FakeTask.last is not None, f"probe winner {winner!r} started no task"
    return _FakeTask.last.kwargs


def _probe_backends(url, message=None, **overrides):
    """Backend ids `_build_probe_configs` emits for `url`, with every tool resolved."""
    kwargs = {
        "url": url,
        "message": message or {},
        "download_dir": "C:/downloads",
        "request_headers": {},
        "cookies_file": None,
        "yt_dlp_command": ["yt-dlp"],
        "ffmpeg_location": None,
        "aria2c_location": None,
        "n_m3u8dl_re_location": "C:/tools/N_m3u8DL-RE.exe",
        "streamlink_command": ["streamlink"],
    }
    kwargs.update(overrides)
    return [config.backend for config in download_manager._build_probe_configs(**kwargs)]


def _canonical(name):
    """Probe ids are dash/snake (`yt-dlp`), HELPER_DEPENDENCIES keys are camelCase (`ytDlp`).

    The two sides of the contract were written by different hands under different
    naming conventions, so a plain string match fails on two of the three live ids.
    Fold the separators and the case together and both spellings agree.
    """
    return re.sub(r"[-_]", "", name).lower()


def _helper_dependency_keys():
    """Every `key:` in HELPER_DEPENDENCIES. Parsed by regex -- it is TypeScript."""
    return set(re.findall(r'key:\s*"(\w+)"', _HELPER_DEPENDENCIES_TS.read_text(encoding="utf-8")))


def test_fallback_chain_retries_without_subtitles_first():
    """A subtitle-only 429 must not burn the whole variant chain.

    `--sub-langs all` fans out to dozens of subtitle requests; one 429 aborts
    the run without writing the video, and every variant kept the same subtitle
    flags, so one YouTube job spent 150s over 9 identical attempts before failing.
    The first fallback must be the bare video, so the download is rescued on
    attempt 2 instead of failing on attempt 9.
    """
    variants = build_yt_dlp_fallback_variants(
        url="https://www.youtube.com/watch?v=x",
        download_dir="C:/downloads",
    )
    assert variants[0]["label"] == "yt-dlp (no subtitles)"
    for flag in ("--write-subs", "--write-auto-subs", "--sub-langs", "--embed-subs"):
        assert flag not in variants[0]["command"], f"no-subtitles variant still carries {flag}"
    assert any("--write-subs" in v["command"] for v in variants[1:]), (
        "the subtitle flags must survive on the later variants, only the rescue attempt drops them"
    )


def test_no_subtitle_variant_skipped_when_base_has_no_subtitles():
    """No rescue variant when there is nothing to rescue from.

    With subtitles already off (or an audio extract, which never adds them) the
    no-subtitles argv would duplicate the base command -- an identical retry
    that can only fail the same way.
    """
    assert "yt-dlp (no subtitles)" not in [
        v["label"]
        for v in build_yt_dlp_fallback_variants(
            url="https://www.youtube.com/watch?v=x",
            download_dir="C:/downloads",
            download_subtitles=False,
        )
    ]
    assert "yt-dlp (no subtitles)" not in [
        v["label"]
        for v in build_yt_dlp_fallback_variants(
            url="https://www.youtube.com/watch?v=x",
            download_dir="C:/downloads",
            extract_audio=True,
        )
    ]


def test_stream_manifest_probes_lead_with_the_stream_backends():
    """List order is the priority order, and the runner scans it lowest-index-first.

    `run_parallel_probes` deliberately owns no priority list of its own: it takes the
    first probe in index order that reported ok. The order therefore has to be encoded
    here, in `_build_probe_configs`, or the doc's "which backend wins" claim is
    unfalsifiable. Reordering this list silently changes which downloader runs.
    """
    assert _probe_backends("https://x.com/a.m3u8") == ["n_m3u8dl_re", "streamlink", "yt-dlp"]


def test_non_stream_url_probes_only_yt_dlp():
    """A direct `.mp4` has no stream to hand to N_m3u8DL-RE or Streamlink.

    The converse failure -- a stream backend listed for a plain file -- would waste two
    probe round-trips per download and advertise a tool the download never uses.
    """
    assert _probe_backends("https://x.com/a.mp4") == ["yt-dlp"]


def test_stream_detection_covers_the_manifest_urls_the_docs_claim():
    """.m3u8, .ism/Manifest and `message.format == "m3u8"` are all stream manifests.

    These are the three shapes the downloaders doc tells people to paste in, so they
    are the three that must reach the stream backends. If `is_stream_manifest_url` stops
    recognising one, yt-dlp silently becomes the only probe and the doc is wrong again.
    """
    assert _probe_backends("https://x.com/a.ism/Manifest") == ["n_m3u8dl_re", "streamlink", "yt-dlp"]
    assert _probe_backends("https://x.com/v", {"format": "m3u8"}) == ["n_m3u8dl_re", "streamlink", "yt-dlp"]


def test_stream_backends_appear_only_when_their_tool_resolves():
    """A manifest URL with neither tool installed must not list them anyway.

    The doc used to imply the backend list is fixed. It is not: it is filtered by what
    the resolvers found on this machine, so documenting the list as unconditional is
    the drift this row exists to prevent.
    """
    assert _probe_backends(
        "https://x.com/a.m3u8",
        n_m3u8dl_re_location=None,
        streamlink_command=None,
    ) == ["yt-dlp"]


def test_every_probe_backend_has_a_helper_dependency_entry():
    """A tool the popup cannot report is a tool the docs cannot promise.

    `HELPER_DEPENDENCIES` is the single source of truth both UIs render (spec D4), so a
    probe backend with no entry there downloads silently while the dependency banner
    claims the machine is set up -- and the docs list a tool with no UI presence.
    """
    known = {_canonical(key) for key in _helper_dependency_keys()}
    orphans = set()
    for url, message in (
        ("https://x.com/a.m3u8", None),
        ("https://x.com/a.mp4", None),
        ("https://x.com/a.ism/Manifest", None),
        ("https://x.com/v", {"format": "m3u8"}),
    ):
        orphans |= {_canonical(backend) for backend in _probe_backends(url, message)} - known
    assert not orphans, f"probe backends with no HELPER_DEPENDENCIES entry: {sorted(orphans)}"


def test_probe_winner_reports_where_the_file_landed():
    """A stream-backend winner must carry its output path into the job.

    The winner branch hands `DownloadTask` a bare command and used to drop the
    `final_path` the Tier-2 chain attaches to every stream fallback. yt-dlp names its
    own output on the wire (`after_move:__QWIN_FILEPATH__`), so it needs no hint and
    gets none; the stream backends emit nothing the progress parser recognises, so a
    stream download finished with `filepath: ""` — and an empty `filepath` is what
    hides the popup's Open / Folder buttons (`downloadActions` gates both on it).

    No subprocess: `run_download` takes `task_class` and `probe_runner_fn` as
    arguments, so the whole branch runs against a recording stand-in.
    """
    assert _task_for_winner("yt-dlp")["final_path"] == "", (
        "yt-dlp reports its own path via the __QWIN_FILEPATH__ marker; a hint here would shadow it"
    )

    for winner in ("streamlink", "n_m3u8dl_re"):
        path = Path(_task_for_winner(winner)["final_path"])
        assert path.name == "Clip.mp4" and path.parent.name == "Clip", f"{winner} winner lost its output path: {path}"


def test_probe_winner_keeps_the_fallback_chain():
    """A probe winner must be the *first* attempt, not the only one.

    A probe only proves the manifest is fetchable -- N_m3u8DL-RE's is
    `--skip-download`, which parses the playlist and stops. It says nothing about
    whether the *segments* download, so a hotlink-protected CDN answering the
    segment request (a Pornhub CDN returns HTTP 471) kills the winner after the
    probe already declared it good. The winner branch passed
    `fallback_commands=[]`, so that failure had nowhere to go: one attempt, then
    `raise HostError` with the raw tool stdout as the user-facing error text.

    Same job as the test above, one layer down -- the winner branch has to hand
    `DownloadTask` both the output path AND the rest of the chain.
    """
    for winner, expected in (
        ("n_m3u8dl_re", "Streamlink"),
        ("streamlink", "N_m3u8DL-RE"),
    ):
        labels = [entry["label"] for entry in _task_for_winner(winner)["fallback_commands"]]
        assert expected in labels, f"{winner} winner dropped the {expected} fallback: {labels}"
        assert winner not in labels, f"{winner} winner re-queued itself as its own fallback: {labels}"


def test_unreachable_probe_backends_stay_deleted():
    """`curl_cffi` and `ffmpeg` are not probe backends, and the priority list is gone.

    `curl_cffi` is a `yt-dlp[default,curl-cffi]` extra that yt-dlp uses for its own TLS
    impersonation -- it was never a download backend. `ffmpeg` is a helper dependency
    and a Tier-2 direct-stream-copy command, but it has no probe. Both were listed in
    the old priority table, so their reappearance as probe ids is the drift signal.

    Checked over the *returned* ids rather than by grepping the source: a passing
    mention in a comment is not a live probe, and grepping would flake on the comment
    that explains the absence.
    """
    for url, message in (("https://x.com/a.m3u8", None), ("https://x.com/a.mp4", None)):
        backends = set(_probe_backends(url, message))
        assert "curl_cffi" not in backends, f"{url} probed curl_cffi: {sorted(backends)}"
        assert "ffmpeg" not in backends, f"{url} probed ffmpeg: {sorted(backends)}"

    source = _PROBE_RUNNER.read_text(encoding="utf-8")
    resurrected = [name for name in ("STREAM_PRIORITY", "DEFAULT_PRIORITY", "winner_found") if name in source]
    assert not resurrected, (
        f"probe_runner.py regained the local priority machinery {resurrected} -- index order is the "
        "priority order and a second table would be a second source of truth"
    )
