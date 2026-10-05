"""Regression test: the log must name the backend that actually ran, and must not
re-run strategy variants that cannot fix the error it just hit.

Two defects, both invisible until you read `downloads.jsonl` line by line:

1. `fallback_attempts()` hardcoded attempt 1's label as `"yt-dlp"`, but
   `run_download` passes the *probe winner's* argv as `DownloadTask.command`. Every
   stream download therefore logged `label: "yt-dlp"` directly above a
   `streamlink.EXE` command line -- so "which backend is this?" had no answer in
   the log, and a 180-second Streamlink attempt read as a yt-dlp one.

2. The chain fell through to the next attempt *unconditionally*. On an expired
   signed URL all nine yt-dlp variants collect the identical `HTTP Error 410`, so
   a pornhub job spent 3.4 of its 4.1 minutes on re-issued doomed requests before
   reaching Streamlink, which fixed it in one shot.

Plus the probe flag: `probe_n_m3u8dl_re` ran `--test`, which the installed
`N_m3u8DL-RE (Beta) 20260628` does not have (absent from `--help`), so the
#1-priority backend lost every probe in ~100ms and was never a winner.

No subprocess, no network: the chain shape is asserted on plain dicts, and the
probe argv is read out of `probe_n_m3u8dl_re`'s source, matching the AST-scan
precedent in `test_host_imports.py`.
"""

import ast
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_NATIVE_HOST = _REPO_ROOT / "src" / "native_host"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in _NATIVE_HOST.walk():
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        path = str(root)
        if path not in sys.path:
            sys.path.insert(0, path)


_add_native_host_to_path()

from download_task import DownloadTask, command_label  # noqa: E402


def _label_task(command, fallbacks=()):
    task = DownloadTask.__new__(DownloadTask)
    task.command = command
    task.fallback_commands = list(fallbacks)
    return task


def _task_with_chain(chain):
    """A DownloadTask whose logger is a no-op recorder, wired for next_attempt_index."""
    task = DownloadTask.__new__(DownloadTask)
    task.id = "job_test"
    task.logger = _RecordingLogger()
    return task, chain


class _RecordingLogger:
    def __init__(self):
        self.lines = []

    def attempt_line(self, _download_id, line):
        self.lines.append(line)


def test_command_label_names_the_real_executable():
    assert command_label([r"C:\…\Python314\Scripts\streamlink.EXE", "url"]) == "Streamlink"
    assert command_label(["N_m3u8DL-RE.exe", "url"]) == "N_m3u8DL-RE"
    assert command_label([r"C:\…\yt-dlp.EXE", "url"]) == "yt-dlp"
    assert command_label(["ffmpeg.EXE"]) == "ffmpeg"
    assert command_label([]) == "unknown"


def test_first_attempt_label_follows_the_probe_winner_not_a_hardcoded_name():
    task = _label_task([r"C:\…\streamlink.EXE", "https://x/master.m3u8", "best"])
    first = task.fallback_attempts()[0]
    assert first["label"] == "Streamlink", "attempt 1's label must come from its own argv"

    ytdlp = _label_task([r"C:\…\yt-dlp.EXE", "https://x/watch"])
    assert ytdlp.fallback_attempts()[0]["label"] == "yt-dlp"


def _chain():
    """The real Tier-2 shape: yt-dlp, N_m3u8DL-RE, 3 variants, Streamlink."""
    return [
        {"label": "yt-dlp"},
        {"label": "N_m3u8DL-RE"},
        {"label": "yt-dlp (no SSL check)", "variant": True},
        {"label": "yt-dlp (max retries)", "variant": True},
        {"label": "yt-dlp (generic extractor)", "variant": True},
        {"label": "Streamlink"},
    ]


def test_expired_url_skips_the_variant_block():
    """N_m3u8DL-RE sits *before* the variants, so it still gets its turn (index 1);
    the 410 is what collapses the variant run at index 2..4 down to Streamlink."""
    task, chain = _task_with_chain(_chain())
    details = "ERROR: [generic] master: Failed to download m3u8 information: HTTP Error 410: Gone"

    assert task.next_attempt_index(chain, 0, details) == 1, "N_m3u8DL-RE is a different HTTP client, must still run"
    nxt = task.next_attempt_index(chain, 1, details)
    assert chain[nxt]["label"] == "Streamlink", "a 410 must not walk 3 more yt-dlp variants"
    assert any("Skipped 3 yt-dlp variants" in line for line in task.logger.lines)


def test_transient_failure_still_walks_the_whole_chain():
    task, chain = _task_with_chain(_chain())
    details = "ERROR: unable to download video data: HTTP Error 503: Service Unavailable"
    assert task.next_attempt_index(chain, 0, details) == 1
    assert task.logger.lines == []


def test_geo_block_403_is_not_treated_as_terminal():
    """--geo-bypass exists to get past a 403, so the chain must still try it."""
    task, chain = _task_with_chain(_chain())
    assert task.next_attempt_index(chain, 0, "ERROR: HTTP Error 403: Forbidden") == 1


def test_skip_never_runs_past_the_end_of_the_chain():
    task, chain = _task_with_chain([{"label": "yt-dlp"}, {"label": "yt-dlp (b)", "variant": True}])
    assert task.next_attempt_index(chain, 0, "HTTP Error 410: Gone") == 2


def test_probe_uses_skip_download_not_the_nonexistent_test_flag():
    """`--test` is not an N_m3u8DL-RE option; its parser rejects the whole argv."""
    source = (_NATIVE_HOST / "probe" / "probe_backends.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    probe_fn = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "probe_n_m3u8dl_re"
    )
    flags = [
        elt.value
        for node in ast.walk(probe_fn)
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.List)
        for elt in node.value.elts
        if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
    ]
    assert "--skip-download" in flags
    assert "--test" not in flags