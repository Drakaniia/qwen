"""Regression tests for the native-host audit fixes (data loss, races, wire shapes).

Each test names the defect it guards. Subprocesses, where used, are tiny
`python -c` one-liners so the tests run anywhere Python does -- no yt-dlp, no
ffmpeg, no network.
"""

import functools
import inspect
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest

_NATIVE_HOST = Path(__file__).resolve().parents[2] / "src" / "native_host"


def _add_native_host_to_path():
    """Mirror the sys.path walk in host.py so flat module imports resolve."""
    for root, dirs, _files in os.walk(_NATIVE_HOST):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith("_")]
        if root not in sys.path:
            sys.path.insert(0, root)


_add_native_host_to_path()

import download_manager  # noqa: E402
import folder_picker  # noqa: E402
import yt_dlp_dependencies  # noqa: E402
from download_task import DownloadTask, StageLogCollapser  # noqa: E402
from log_utils import _redact_str  # noqa: E402
from native_paths import validate_download_url  # noqa: E402
from native_protocol import HostError  # noqa: E402
from probe_runner import ProbeResult  # noqa: E402
from progress_parser import FILEPATH_MARKER  # noqa: E402
from stream_backends import reserve_stream_output_path  # noqa: E402
from yt_dlp_command import build_yt_dlp_command, format_selector_for_choice, summarize_formats  # noqa: E402

CLOUDFLARE_PAGE = (
    b"<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>"
    b"<body>cf-chl challenge-platform " + b"x" * 200 + b"</body></html>"
)


class _NullLogger:
    """Accepts every DownloadLogger call and writes nothing."""

    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


def _task(download_dir, command, messages, **kwargs):
    return DownloadTask(
        message={"id": "job-1", "url": "https://example.com/v.mp4"},
        command=command,
        download_dir=download_dir,
        send=messages.append,
        logger=_NullLogger(),
        **kwargs,
    )


def _python(code):
    return [sys.executable, "-c", code]


def _run(task, timeout=30):
    task.start()
    task.thread.join(timeout)
    assert not task.thread.is_alive(), "download task did not finish"


# ── C1: a Cloudflare page must never cost the user their download folder ──────


def test_cloudflare_output_deletes_only_the_job_file_never_the_download_root(tmp_path):
    root = tmp_path / "Downloads-ish"
    root.mkdir()
    keep = [root / "holiday.mp4", root / "saved page.html"]
    keep[0].write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    # A saved web page that *looks* like a challenge: the old folder scan matched it
    # and rmtree'd the whole folder.
    keep[1].write_bytes(CLOUDFLARE_PAGE)
    job_file = root / "Clip [abc].mp4"
    job_file.write_bytes(CLOUDFLARE_PAGE)

    messages = []
    # The FILEPATH marker is exactly what yt-dlp prints; the parser turns it into
    # final_path AND artifactRoot = its parent = the download folder itself.
    task = _task(root, _python(f"print({FILEPATH_MARKER + str(job_file)!r})"), messages)
    _run(task)

    assert root.is_dir(), "the download folder itself was deleted"
    for path in keep:
        assert path.exists(), f"{path.name} (not this job's file) was deleted"
    assert not job_file.exists(), "the job's own Cloudflare page should be removed"
    assert messages[-1]["type"] == "error" and "Cloudflare" in messages[-1]["error"]


def test_clean_output_in_root_is_reported_done(tmp_path):
    job_file = tmp_path / "Clip.mp4"
    job_file.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 400)
    messages = []
    _run(_task(tmp_path, _python(f"print({FILEPATH_MARKER + str(job_file)!r})"), messages))
    assert messages[-1]["type"] == "done"
    assert job_file.exists()


# ── C2: stream jobs get a path of their own ───────────────────────────────────


def test_stream_output_paths_are_unique_per_job(tmp_path):
    first = reserve_stream_output_path(tmp_path, "Video")
    second = reserve_stream_output_path(tmp_path, "Video")
    assert first != second
    assert first.parent.is_dir() and second.parent.is_dir()
    assert (first.parent.name, first.name) == ("Video", "Video.mp4")
    assert (second.parent.name, second.name) == ("Video (2)", "Video (2).mp4")


def test_concurrent_reservations_never_share_a_folder(tmp_path):
    results = []
    lock = threading.Lock()

    def reserve():
        path = reserve_stream_output_path(tmp_path, "Same Title")
        with lock:
            results.append(path)

    threads = [threading.Thread(target=reserve) for _ in range(12)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len({str(p) for p in results}) == 12


@pytest.mark.parametrize("title", ["CON", "nul", "COM1", "", None, "a/b:c*?"])
def test_stream_output_path_survives_reserved_and_illegal_titles(tmp_path, title):
    path = reserve_stream_output_path(tmp_path, title)
    assert path.parent.parent == tmp_path
    assert path.stem.upper() not in {"CON", "NUL", "COM1"}
    assert not any(ch in path.name for ch in '<>:"/\\|?*')


def test_stream_cancel_removes_only_its_own_folder(tmp_path):
    other_job = reserve_stream_output_path(tmp_path, "Video")
    other_job.write_bytes(b"finished by another job")
    unrelated = tmp_path / "unrelated.mp4"
    unrelated.write_bytes(b"keep me")

    mine = reserve_stream_output_path(tmp_path, "Video")
    mine.write_bytes(b"partial")
    task = _task(tmp_path, _python("pass"), [])
    task.owned_dirs = [str(mine.parent)]
    task.final_path = str(mine)
    task.artifact_root = str(mine.parent)

    cleanup = task.cleanup_canceled_artifacts()

    assert not mine.parent.exists()
    assert other_job.exists() and unrelated.exists()
    assert cleanup["artifactCleanupDeleted"] == [str(mine.parent.resolve())]


def test_ytdlp_cancel_removes_announced_partials_only(tmp_path):
    name = "Movie [x1].mp4"
    partials = [tmp_path / f"{name}.part", tmp_path / f"{name}.part-Frag3", tmp_path / f"{name}.ytdl"]
    for path in partials:
        path.write_bytes(b"p")
    keep = [tmp_path / "Other [y2].mp4.part", tmp_path / "Movie [x1] (old).mp4", tmp_path / "notes.txt"]
    for path in keep:
        path.write_bytes(b"k")

    task = _task(tmp_path, _python("pass"), [])
    task.stage_log = StageLogCollapser(lambda _line: None)
    task.handle_output_line(f"[download] Destination: {tmp_path / name}")
    task.cleanup_canceled_artifacts()

    assert tmp_path.is_dir()
    for path in partials:
        assert not path.exists(), f"{path.name} should be removed"
    for path in keep:
        assert path.exists(), f"{path.name} is not this job's and must survive"


def test_aria2c_cancel_removes_its_part_and_control_file(tmp_path):
    """Seen in the E2E run: yt-dlp+aria2c prints no `Destination:`, only aria2c's
    `FILE:` summary, and the canceled job left `X.mp4.part` + `X.mp4.part.aria2`."""
    part = tmp_path / "long [long].mp4.part"
    control = tmp_path / "long [long].mp4.part.aria2"
    keep = tmp_path / "keep_me.txt"
    for path in (part, control, keep):
        path.write_bytes(b"x")
    task = _task(tmp_path, _python("pass"), [])
    task.stage_log = StageLogCollapser(lambda _line: None)
    task.handle_output_line(f"FILE: {tmp_path.as_posix()}//./{part.name}")
    task.cleanup_canceled_artifacts()
    assert not part.exists() and not control.exists()
    assert keep.exists()


def test_cancel_never_deletes_a_file_that_existed_before_the_job(tmp_path):
    existing = tmp_path / "Song [z].mp4"
    existing.write_bytes(b"downloaded last week")
    task = _task(tmp_path, _python("pass"), [])
    task.stage_log = StageLogCollapser(lambda _line: None)
    task.handle_output_line(f"[download] Destination: {existing}")
    task.cleanup_canceled_artifacts()
    assert existing.exists()


# ── C3: aria2c is optional ────────────────────────────────────────────────────


def test_aria2c_is_optional():
    assert not hasattr(yt_dlp_dependencies, "require_aria2c_location")
    default = inspect.signature(download_manager.run_download).parameters["aria2c_location_resolver"].default
    assert default is yt_dlp_dependencies.resolve_aria2c_location

    command = build_yt_dlp_command("https://example.com/v.mp4", "C:/d", aria2c_location=None)
    assert "--downloader" not in command


# ── Races ─────────────────────────────────────────────────────────────────────


def test_pause_before_the_process_starts_starts_nothing(tmp_path):
    marker = tmp_path / "ran.txt"
    task = _task(tmp_path, _python(f"open({str(marker)!r}, 'w').close()"), [])
    task.pause()
    assert task.run_process_once() is None
    assert task.state == "pausing", "run_process_once overwrote the pausing state"
    assert not marker.exists()


def test_pause_right_after_a_clean_exit_does_not_rerun(tmp_path):
    counter = tmp_path / "runs.txt"
    messages = []
    task = _task(tmp_path, _python(f"open({str(counter)!r}, 'a').write('x')"), messages)
    original = task.run_process_once

    def run_then_pause(command=None):
        code = original(command)
        task.pause_requested.set()  # lands in the instant after a successful exit
        return code

    task.run_process_once = run_then_pause
    _run(task)
    assert counter.read_text() == "x", "the download ran again after it had finished"
    assert messages[-1]["type"] == "done"


def test_shutdown_kills_the_downloader_and_keeps_partial_files(tmp_path):
    """Seen in the merged E2E run: on stdin EOF the host returned and left yt-dlp
    running as an orphan, which then raced the resumed download for its `.part`."""
    partial = tmp_path / "clip [c].mp4.part"
    messages = []
    task = _task(
        tmp_path,
        _python(f"import time; open({str(partial)!r}, 'w').write('p'); time.sleep(60)"),
        messages,
    )
    task.on_finished = download_manager.register_task("job-1", task)
    task.start()
    deadline = time.monotonic() + 10
    while task.process is None or not partial.exists():
        assert time.monotonic() < deadline, "the fake downloader never started"
        time.sleep(0.05)

    process = task.process  # the task drops its handle once the attempt ends
    started = time.monotonic()
    assert download_manager.shutdown_all_downloads(join_timeout=15) == 1
    assert time.monotonic() - started < 15
    assert not task.thread.is_alive(), "a shut-down task must end its thread"
    assert process.poll() is not None, "the downloader process was left running"
    assert partial.exists(), "shutdown is not a cancel: the partial file is what Resume needs"
    assert not any(m.get("type") in {"canceled", "error", "done"} for m in messages), messages
    assert "job-1" not in download_manager.ACTIVE_DOWNLOADS


def test_shutdown_ends_a_paused_task(tmp_path):
    task = _task(tmp_path, _python("import time; time.sleep(60)"), [])
    task.on_finished = download_manager.register_task("job-1", task)
    task.pause()  # paused before its process starts: the thread waits for a resume
    task.start()
    time.sleep(0.3)
    assert task.thread.is_alive()
    download_manager.shutdown_all_downloads(join_timeout=10)
    assert not task.thread.is_alive(), "a paused task kept the host process alive"


def test_cancel_during_probing_reaches_the_task(tmp_path):
    messages = []
    probe_started = threading.Event()

    def slow_probe(cancel_event, **_kwargs):
        probe_started.set()
        cancel_event.wait(20)
        return ProbeResult(winner=None, command=None, label=None)

    download_manager.run_download(
        {"id": "probe-cancel", "url": "https://x.com/a.m3u8", "title": "T", "downloadFolder": str(tmp_path)},
        task_class=functools.partial(DownloadTask, send=messages.append, logger=_NullLogger()),
        yt_dlp_command_resolver=lambda: [sys.executable, "-c", "raise SystemExit(3)"],
        ffmpeg_location_resolver=lambda: "ffmpeg",
        aria2c_location_resolver=lambda: None,
        n_m3u8dl_re_location_resolver=lambda: None,
        streamlink_command_resolver=lambda: None,
        probe_runner_fn=slow_probe,
    )
    assert probe_started.wait(10)
    replies = []
    started = time.monotonic()
    download_manager.control_download({"id": "probe-cancel"}, "cancel", send=replies.append)
    assert replies[0]["status"] == "canceling"

    deadline = time.monotonic() + 10
    while not any(m.get("type") == "canceled" for m in messages) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert any(m.get("type") == "canceled" for m in messages), messages
    assert time.monotonic() - started < 10
    assert not (tmp_path / "T").exists(), "the reserved stream folder should be cleaned up"
    assert "probe-cancel" not in download_manager.ACTIVE_DOWNLOADS


# ── Control of an unknown task ────────────────────────────────────────────────


@pytest.mark.parametrize("action", ["pause", "resume", "cancel"])
def test_control_of_unknown_task_is_not_an_error(action):
    replies = []
    download_manager.control_download({"id": "no-such-job"}, action, send=replies.append)
    assert replies == [
        {
            "type": "control",
            "id": "no-such-job",
            "action": action,
            "status": "gone",
            "message": "This download is no longer running in the helper.",
        }
    ]


# ── Temp files never leak ─────────────────────────────────────────────────────


def _qwin_temp_files():
    tmp = Path(tempfile.gettempdir())
    return {p.name for p in tmp.glob("qwin-*") if p.is_file()}


def test_temp_files_are_removed_when_the_task_cannot_be_built(tmp_path):
    before = _qwin_temp_files()

    def exploding_task(**_kwargs):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        download_manager.run_download(
            {
                "id": "leak-1",
                "url": "https://example.com/v.mp4",
                "downloadFolder": str(tmp_path),
                "cookieHeader": "session=secret",
                "requestHeaders": [{"name": "Authorization", "value": "Bearer secret"}],
            },
            task_class=exploding_task,
            yt_dlp_command_resolver=lambda: ["yt-dlp"],
            ffmpeg_location_resolver=lambda: "ffmpeg",
            aria2c_location_resolver=lambda: None,
            n_m3u8dl_re_location_resolver=lambda: None,
            streamlink_command_resolver=lambda: None,
        )
    assert _qwin_temp_files() - before == set(), "cookie/header temp files leaked"
    assert "leak-1" not in download_manager.ACTIVE_DOWNLOADS


# ── maxHeight / recode ────────────────────────────────────────────────────────


def test_max_height_caps_best_and_degrades_gracefully():
    capped = "bv*[height<=480]+ba/b[height<=480]/bv*+ba/b"
    assert format_selector_for_choice("best", max_height=480) == capped
    assert format_selector_for_choice("", max_height="480") == capped
    command = build_yt_dlp_command("https://example.com/v", "C:/d", max_height=480)
    assert command[command.index("-f") + 1] == capped


def test_max_height_is_ignored_for_explicit_formats_music_and_zero():
    assert "height" not in format_selector_for_choice("137", max_height=480)
    assert "height" not in format_selector_for_choice("best", extract_audio=True, max_height=480)
    assert "height" not in format_selector_for_choice("best", max_height=0)
    assert "height" not in format_selector_for_choice("best", max_height="junk")


def test_explicit_format_keeps_the_choice_when_there_is_no_separate_audio():
    assert format_selector_for_choice("hls-720") == "hls-720+bestaudio/hls-720/best"


def test_video_downloads_remux_instead_of_recoding():
    command = build_yt_dlp_command("https://example.com/v.webm", "C:/d")
    assert "--recode-video" not in command
    assert command[command.index("--remux-video") + 1] == "mp4"
    assert command[command.index("--merge-output-format") + 1] == "mp4"

    audio = build_yt_dlp_command("https://example.com/v.webm", "C:/d", extract_audio=True)
    assert "--extract-audio" in audio and "--remux-video" not in audio


# ── formats response ──────────────────────────────────────────────────────────


def test_formats_carry_duration_and_audio_only_streams():
    info = {
        "title": "T",
        "duration": 10.0,
        "formats": [
            {"format_id": "a1", "vcodec": "none", "acodec": "opus", "abr": 128, "ext": "webm", "protocol": "https"},
            {"format_id": "v1", "vcodec": "avc1", "acodec": "mp4a", "height": 720, "ext": "mp4", "protocol": "https"},
        ],
    }
    summary = summarize_formats(info)
    assert summary["duration"] == 10
    assert [f["id"] for f in summary["formats"]] == ["best", "v1"]
    assert all(f["kind"] == "video" for f in summary["formats"])
    audio = summary["audioFormats"]
    assert len(audio) == 1
    assert audio[0]["id"] == "a1/bestaudio" and audio[0]["formatId"] == "a1"
    assert audio[0]["kind"] == "audio" and audio[0]["vcodec"] == "none"
    assert audio[0]["acodec"] == "opus" and audio[0]["abr"] == 128 and audio[0]["ext"] == "webm"
    # The audio id is a complete selector: it downloads exactly that stream.
    assert format_selector_for_choice(audio[0]["id"]) == "a1/bestaudio"


def test_hls_only_source_lists_its_renditions():
    info = {
        "title": "HLS",
        "duration": 9.98,
        "formats": [
            {"format_id": "hls-400", "protocol": "m3u8_native", "height": 360, "tbr": 400, "ext": "mp4"},
            {"format_id": "hls-1500", "protocol": "m3u8_native", "height": 720, "tbr": 1500, "ext": "mp4"},
        ],
    }
    summary = summarize_formats(info)
    ids = [f["id"] for f in summary["formats"]]
    assert ids == ["best", "hls-1500", "hls-400"]
    assert all(f.get("streaming") for f in summary["formats"][1:])
    assert summary["duration"] == 9.98


def test_direct_link_with_unknown_codecs_is_a_video_not_nothing():
    info = {"title": "direct", "formats": [{"format_id": "mp4", "url": "https://e/v.mp4", "ext": "mp4"}]}
    summary = summarize_formats(info)
    assert [f["id"] for f in summary["formats"]] == ["best", "mp4"]
    assert summary["duration"] is None
    assert summary["audioFormats"] == []


# ── misc ──────────────────────────────────────────────────────────────────────


def test_magnet_links_are_rejected():
    with pytest.raises(HostError):
        validate_download_url("magnet:?xt=urn:btih:abcdef")


def test_signed_url_params_are_redacted():
    url = (
        "https://cdn.example/v.mp4?expire=1&lsig=SECRET1&sig=SECRET2&X-Amz-Signature=SECRET3"
        "&X-Amz-Credential=SECRET4&Policy=SECRET5&Key-Pair-Id=SECRET6&token=SECRET7"
    )
    redacted = _redact_str(url)
    for n in range(1, 8):
        assert f"SECRET{n}" not in redacted
    assert "expire=1" in redacted


def test_folder_picker_times_out_instead_of_hanging(monkeypatch):
    def timeout(*args, **kwargs):
        assert kwargs.get("timeout") == folder_picker.FOLDER_PICKER_TIMEOUT_SECONDS
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(folder_picker.shutil, "which", lambda _name: "powershell.exe")
    monkeypatch.setattr(folder_picker.subprocess, "run", timeout)
    with pytest.raises(HostError):
        folder_picker.choose_download_folder_with_powershell("")


def test_host_does_not_use_python_312_only_path_walk():
    source = (_NATIVE_HOST / "host.py").read_text(encoding="utf-8")
    assert ".walk()" not in source


def test_no_native_host_subprocess_uses_a_shell():
    offenders = [
        str(path.relative_to(_NATIVE_HOST))
        for path in _NATIVE_HOST.rglob("*.py")
        if "shell=True" in path.read_text(encoding="utf-8")
    ]
    assert offenders == []
