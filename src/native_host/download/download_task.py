import errno
import shutil
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

from download_logger import get_logger
from parsers import new_parser_state, parse_line

from artifacts import unique_delete_targets
from browser_context import remove_temp_files
from native_protocol import HostError, send_native_message
from process_control import creation_flags, terminate_process_tree
from progress_parser import is_cloudflare_challenge, iter_process_output_lines

# 4 progress frames per second to the browser (spec D3). N_m3u8DL-RE repaints its
# grid ~10x/sec and would otherwise spend that budget in storage writes.
PROGRESS_INTERVAL = 0.25

# Terminal or otherwise state-changing: never deferred by the throttle.
ALWAYS_SEND_TYPES = frozenset({"started", "done", "error", "canceled", "paused", "resumed", "control"})

# Executable stem -> the label the rest of the log and the popup already use.
# Attempt 1 is not always yt-dlp: `run_download` hands `DownloadTask.command`
# whichever argv the probe picked as winner, so a streamlink win was writing
# `label: "yt-dlp"` directly above a `streamlink.EXE` command line. Anyone
# reading downloads.jsonl could not tell which backend had actually run.
_BACKEND_LABELS = {
    "yt-dlp": "yt-dlp",
    "streamlink": "Streamlink",
    "n_m3u8dl-re": "N_m3u8DL-RE",
}


def command_label(command):
    """Human label for an argv, taken from the executable that will run."""
    stem = Path(command[0]).stem if command else ""
    return _BACKEND_LABELS.get(stem.lower(), stem or "unknown")


# Markers for an error no yt-dlp *strategy variant* can fix, because the signed
# URL itself is dead: every variant re-fetches the same manifest with the same
# signature, so --no-check-certificate / --geo-bypass / --force-generic-extractor
# / --throttled-rate / --retries infinite all collect the identical HTTP 410.
# Only a different HTTP client (N_m3u8DL-RE, Streamlink, ffmpeg) can still get
# through, so `DownloadTask.next_attempt_index` skips the variant block outright.
#
# 403 is deliberately NOT here -- --geo-bypass exists to get past geo-blocked
# 403s, so that is a variant the chain must still try. "http error 410" is
# yt-dlp's wording for the page/manifest fetch ("Failed to download m3u8
# information: HTTP Error 410: Gone"), not for a fragment, which retries can fix.
_TERMINAL_URL_ERROR_MARKERS = ("http error 410", "has expired")


class ProgressThrottle:
    """Rate-limits progress frames, never state changes (spec §5.1).

    Always-forward beats throttled for anything that changes what the popup
    shows structurally: the terminal message types, a payload carrying the
    output path, and the first frame of a new stage (so a stage transition does
    not arrive up to one interval late). Only the continuous byte counter is
    rate-limited. `clock` is injectable so the interval can be tested against a
    fake clock.
    """

    def __init__(self, interval=PROGRESS_INTERVAL, clock=time.monotonic):
        self.interval = interval
        self.clock = clock
        self.last_sent = None
        self.stage = None

    def allow(self, message):
        if message.get("type") in ALWAYS_SEND_TYPES:
            return True
        if message.get("filepath") or message.get("artifactRoot"):
            return True
        stage = message.get("stage")
        now = self.clock()
        if stage != self.stage:
            self.stage = stage
            self.last_sent = now
            return True
        if self.last_sent is None or now - self.last_sent >= self.interval:
            self.last_sent = now
            return True
        return False


class StageLogCollapser:
    """D8: progress frames must not reach the git-tracked debug log.

    Logs a stage's transition line and its last line, and nothing in between. The
    full tail is still kept in `DownloadTask.recent_lines`, so `HostError` error
    quality is unchanged.
    """

    def __init__(self, log):
        self._log = log
        self.stage = None
        self.first = ""
        self.last = ""

    def observe(self, stage, line):
        if stage != self.stage:
            self.flush()
            self.stage = stage
            self.first = line
            self._log(line)
        self.last = line

    def flush(self):
        if self.last and self.last != self.first:
            self._log(self.last)
        self.last = ""


class DownloadTask:
    def __init__(
        self,
        message,
        command,
        download_dir,
        send=send_native_message,
        fallback_commands=None,
        temp_files=None,
        logger=None,
        final_path=None,
    ):
        self.message = message
        self.command = command
        self.fallback_commands = list(fallback_commands or [])
        self.download_dir = download_dir
        self.send = send
        self.temp_files = list(temp_files or [])
        self.id = str(message.get("id") or message.get("requestId") or "")
        self.lock = threading.Lock()
        self.pause_requested = threading.Event()
        self.resume_requested = threading.Event()
        self.cancel_requested = threading.Event()
        self.process = None
        self.state = "queued"
        # Seeded by the caller when the backend writes to a path we already know and
        # will not report (`download_manager.winner_output_path`). yt-dlp still fills
        # this from its `__QWIN_FILEPATH__` marker, and `run()` only overwrites it when
        # it is still empty, so the two routes agree.
        self.final_path = final_path or None
        self.current_path = None
        self.artifact_root = None
        self.recent_lines = deque(maxlen=25)
        self.thread = None
        self.active_command_meta = None
        self.parser_state = {}
        self.throttle = ProgressThrottle()
        self.stage_log = None
        self.output_disconnected = False
        self.logger = logger or get_logger()
        self.start_time = 0.0

    def start(self):
        self.thread = threading.Thread(target=self.run, name=f"qwin-download-{self.id}", daemon=False)
        self.thread.start()
        return self.thread

    def set_state(self, state):
        with self.lock:
            self.state = state

    def send_message(self, message, force=False):
        if self.output_disconnected:
            return
        if not force and not self.throttle.allow(message):
            return
        try:
            self.send({"id": self.id, **message})
        except BrokenPipeError:
            self.output_disconnected = True
        except OSError as exc:
            if exc.errno not in {errno.EBADF, errno.EINVAL, errno.EPIPE}:
                raise
            self.output_disconnected = True
        except ValueError as exc:
            if "closed" not in str(exc).lower():
                raise
            self.output_disconnected = True

    def artifact_message(self):
        return {
            "path": self.current_path or self.final_path or "",
            "artifactRoot": self.artifact_root or "",
            "downloadFolder": str(self.download_dir),
        }

    def run_process_once(self, command=None):
        active_command = command or self.command
        if self.active_command_meta:
            final_path = self.active_command_meta.get("final_path")
            artifact_root = self.active_command_meta.get("artifact_root")
            if final_path:
                self.current_path = final_path
            if artifact_root:
                self.artifact_root = artifact_root
        self.set_state("starting")
        try:
            # ── Diagnostic: log command details before starting ──────────────
            cmd_str = subprocess.list2cmdline(active_command)
            cmd_len = len(cmd_str)
            cwd_str = str(self.download_dir)
            self.logger.attempt_line(
                self.id,
                f"[DIAG] cmd_len={cmd_len} cwd_len={len(cwd_str)} cmd_args={len(active_command)} cwd='{cwd_str}'",
            )
            if cmd_len > 30000:
                self.logger.attempt_line(
                    self.id,
                    f"[DIAG] Command length {cmd_len} approaching 32767 limit! First 500: {cmd_str[:500]}",
                )
            if len(cwd_str) > 240:
                self.logger.attempt_line(
                    self.id,
                    f"[DIAG] cwd path length {len(cwd_str)} near MAX_PATH (260)!",
                )
            # Check if any individual arg exceeds MAX_PATH
            for idx, arg in enumerate(active_command):
                if len(arg) > 200:
                    self.logger.attempt_line(
                        self.id,
                        f"[DIAG] arg[{idx}] len={len(arg)} (possible MAX_PATH issue): {arg[:300]}",
                    )

            process = subprocess.Popen(
                active_command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                cwd=cwd_str,
                creationflags=creation_flags(),
            )
        except OSError as exc:
            # Re-raise with diagnostics in the error message
            diag = f"cmd_len={cmd_len} cwd='{cwd_str}' cmd_args={len(active_command)} "
            raise HostError(f"Could not start yt-dlp: {exc} [{diag}]") from exc

        with self.lock:
            self.process = process
            self.state = "running"

        # Per attempt, so a fallback does not inherit the previous attempt's
        # fragment counters, stage or throttle window.
        self.throttle = ProgressThrottle()
        self.stage_log = StageLogCollapser(lambda line: self.logger.attempt_line(self.id, line))

        assert process.stdout is not None
        for line in iter_process_output_lines(process.stdout):
            self.handle_output_line(line)

        self.stage_log.flush()

        exit_code = process.wait()
        with self.lock:
            if self.process is process:
                self.process = None
        return exit_code

    def handle_output_line(self, line):
        """Classify one line of subprocess output, then keep/log/send it."""
        parsed = parse_line(line, state=self.parser_state)
        if parsed.get("filepath"):
            self.current_path = parsed["filepath"]
        if parsed.get("artifactRoot"):
            self.artifact_root = parsed["artifactRoot"]
        if parsed["stage"] == "filepath":
            self.final_path = parsed["filepath"]
        else:
            line_text = parsed.get("line", "")
            self.recent_lines.append(line_text)
            self.stage_log.observe(parsed["stage"], line_text)
        self.send_message({"type": "progress", **parsed})

    def _check_cloudflare_in_artifacts(self) -> bool:
        """Check ALL files in the artifact folder for Cloudflare challenge content.

        Checks every file regardless of extension (not just .mp4 and .ts)
        to catch Cloudflare HTML saved as .m4s, .cmfv, .cmfa, or extensionless files.

        Returns True if Cloudflare challenge content is found in any fragment.
        """
        if not self.artifact_root or not Path(self.artifact_root).is_dir():
            return False
        try:
            # Check ALL files in the artifact folder, regardless of extension
            all_files = list(Path(self.artifact_root).glob("*"))
            for fragment_file in all_files[:10]:  # Check up to 10 files
                if not fragment_file.is_file():
                    continue
                try:
                    with open(fragment_file, "rb") as f:
                        header = f.read(2000)
                    if is_cloudflare_challenge(header):
                        self.logger.attempt_line(
                            self.id,
                            f"Fragment {fragment_file.name} appears to be a Cloudflare challenge page.",
                        )
                        return True
                except Exception:
                    continue
        except Exception:
            pass
        return False

    def fallback_attempts(self):
        attempts = [{"command": self.command, "label": command_label(self.command)}]
        attempts.extend(self.fallback_commands)
        return attempts

    def next_attempt_index(self, attempts, attempt_index, error_text):
        """Index of the next attempt, skipping variants that cannot fix `error_text`.

        Unconditional fall-through is right for a transient failure and waste for a
        dead signed URL: a 410 costs ~2s per variant, so a 9-variant block burns
        ~3.5 minutes re-issuing the same doomed request before the chain reaches a
        backend that would have worked. Variants are marked with `"variant": True`
        in `run_download`; only that contiguous block is skipped, and only when the
        error is terminal.
        """
        attempt_index += 1
        if attempt_index >= len(attempts):
            return attempt_index
        text = str(error_text or "").lower()
        if not any(marker in text for marker in _TERMINAL_URL_ERROR_MARKERS):
            return attempt_index
        skipped = []
        while attempt_index < len(attempts) and attempts[attempt_index].get("variant"):
            skipped.append(str(attempts[attempt_index].get("label") or ""))
            attempt_index += 1
        if skipped:
            self.logger.attempt_line(
                self.id,
                f"Skipped {len(skipped)} yt-dlp variants that cannot fix this error: {', '.join(skipped)}",
            )
        return attempt_index

    def run(self):
        self.start_time = time.time()

        # Log the download init event
        self.logger.init(
            download_id=self.id,
            url=self.message.get("url", ""),
            page_url=self.message.get("pageUrl", ""),
            fmt=self.message.get("format", ""),
            selected_format=self.message.get("formatId", "best"),
            backend=self.message.get("backend", "auto"),
            extract_audio=bool(self.message.get("musicMode") or self.message.get("extractAudio") or False),
            audio_format=self.message.get("audioFormat", ""),
            title=self.message.get("title", ""),
            download_folder=str(self.download_dir),
        )

        try:
            attempts = self.fallback_attempts()
            attempt_index = 0
            attempt_num = 0

            while attempt_index < len(attempts):
                if self.cancel_requested.is_set():
                    self.send_canceled()
                    return

                attempt_num += 1
                active_meta = attempts[attempt_index]
                self.active_command_meta = active_meta
                self.parser_state = new_parser_state(self.message)

                label = str(active_meta.get("label") or "unknown")
                self.logger.attempt_start(
                    download_id=self.id,
                    attempt_num=attempt_num,
                    label=label,
                    command=active_meta["command"],
                )

                self.send_message(
                    {
                        "type": "started",
                        "status": "running",
                        # D14: the popup names the attempt, so a download falling
                        # through six backends is explicable instead of silent.
                        "label": label,
                        "message": (f"Saving to {self.download_dir}" if attempt_num == 1 else f"Trying {label}…"),
                    }
                )
                exit_code = self.run_process_once(active_meta["command"])

                self.logger.attempt_end(
                    download_id=self.id,
                    attempt_num=attempt_num,
                    exit_code=exit_code,
                    recent_lines=list(self.recent_lines),
                )

                if self.cancel_requested.is_set():
                    self.send_canceled()
                    return

                if self.pause_requested.is_set():
                    if not self.wait_for_resume_or_cancel():
                        self.send_canceled()
                        return
                    continue

                if exit_code == 0:
                    final_path = active_meta.get("final_path")
                    artifact_root = active_meta.get("artifact_root")
                    if final_path and not self.final_path:
                        self.final_path = final_path
                    if artifact_root and not self.artifact_root:
                        self.artifact_root = artifact_root

                    # ── Validate downloaded content (detect Cloudflare blocks) ──────
                    cloudflare_detected = False
                    if self.final_path and Path(self.final_path).exists():
                        try:
                            with open(self.final_path, "rb") as f:
                                header = f.read(2000)
                            if is_cloudflare_challenge(header):
                                cloudflare_detected = True
                                msg = (
                                    "Downloaded file appears to be a Cloudflare"
                                    " challenge page (anti-bot protection blocked content)."
                                )
                                self.logger.attempt_line(self.id, msg)
                        except Exception:
                            pass

                    # Also check for Cloudflare pages among downloaded fragments
                    # (when the merged file is small or corrupted)
                    # Uses _check_cloudflare_in_artifacts() which checks ALL files
                    # regardless of extension (.ts, .m4s, .cmfv, .cmfa, extensionless, etc.)
                    if not cloudflare_detected:
                        cloudflare_detected = self._check_cloudflare_in_artifacts()

                    if cloudflare_detected:
                        # Remove the corrupted file and treat as download failure
                        try:
                            Path(self.final_path).unlink(missing_ok=True)
                        except Exception:
                            pass
                        # Clean up artifact folder too
                        if self.artifact_root:
                            try:
                                shutil.rmtree(self.artifact_root, ignore_errors=True)
                            except Exception:
                                pass
                        self.set_state("error")
                        duration = time.time() - self.start_time
                        err_msg = "Download blocked by Cloudflare anti-bot protection. Unable to download this video."
                        self.logger.error(
                            download_id=self.id,
                            error_text=err_msg,
                            duration_seconds=duration,
                            attempt_number=attempt_num,
                        )
                        self.send_message(
                            {
                                "type": "error",
                                "status": "error",
                                "filepath": "",
                                "artifactRoot": "",
                                "error": err_msg,
                            }
                        )
                        return

                    self.set_state("done")
                    duration = time.time() - self.start_time
                    self.logger.complete(
                        download_id=self.id,
                        filepath=self.final_path or "",
                        artifact_root=self.artifact_root or "",
                        duration_seconds=duration,
                        message="Download complete.",
                    )
                    self.send_message(
                        {
                            "type": "done",
                            "status": "done",
                            "filepath": self.final_path,
                            "artifactRoot": (
                                self.artifact_root or (str(Path(self.final_path).parent) if self.final_path else "")
                            ),
                            "message": "Download complete.",
                        }
                    )
                    return

                # exit_code != 0 — gather error details
                details = "\n".join(item for item in self.recent_lines if item).strip()
                if not details:
                    details = f"yt-dlp exited with status {exit_code}."

                # Check if audio post-processing failed but the original file exists
                # (--no-post-overwrites / --keep-video keeps the original download)
                if any(
                    keyword in details.lower()
                    for keyword in ["audio conversion failed", "postprocess", "conversion failed"]
                ):
                    original_path = self.current_path or self.final_path or ""
                    if original_path and Path(original_path).exists():
                        self.set_state("done")
                        duration = time.time() - self.start_time
                        self.logger.complete(
                            download_id=self.id,
                            filepath=str(original_path),
                            artifact_root=str(Path(original_path).parent),
                            duration_seconds=duration,
                            message="Download complete (audio conversion skipped, original format kept).",
                        )
                        self.send_message(
                            {
                                "type": "done",
                                "status": "done",
                                "filepath": str(original_path),
                                "artifactRoot": str(Path(original_path).parent),
                                "message": "Download complete (audio conversion skipped, original format kept).",
                            }
                        )
                        return

                # Try the next fallback command -- unless the error is one no yt-dlp
                # strategy variant can fix, in which case skip that block entirely.
                attempt_index = self.next_attempt_index(attempts, attempt_index, details)
                if attempt_index < len(attempts):
                    from_label = label
                    next_meta = attempts[attempt_index]
                    to_label = str(next_meta.get("label") or "another downloader")
                    self.logger.fallback(
                        download_id=self.id,
                        attempt_num=attempt_num,
                        from_label=from_label,
                        to_label=to_label,
                    )
                    self.recent_lines.clear()
                    self.send_message(
                        {
                            "type": "progress",
                            "stage": "log",
                            "line": f"yt-dlp could not use this source; retrying with {to_label}.",
                        },
                        force=True,
                    )
                    continue

                # All fallback attempts exhausted
                raise HostError(details)
        except HostError as exc:
            if self.cancel_requested.is_set():
                self.send_canceled()
            else:
                duration = time.time() - self.start_time
                self.logger.error(
                    download_id=self.id,
                    error_text=str(exc),
                    duration_seconds=duration,
                    attempt_number=attempt_num,
                )
                self.set_state("error")
                self.send_message(
                    {
                        "type": "error",
                        "status": "error",
                        "filepath": self.current_path or self.final_path or "",
                        "artifactRoot": self.artifact_root or "",
                        "error": str(exc),
                    }
                )
        except Exception as exc:
            duration = time.time() - self.start_time
            error_text = f"Unexpected helper error: {exc}"
            self.logger.error(
                download_id=self.id,
                error_text=error_text,
                duration_seconds=duration,
                attempt_number=attempt_num,
            )
            self.set_state("error")
            self.send_message(
                {
                    "type": "error",
                    "status": "error",
                    "filepath": self.current_path or self.final_path or "",
                    "artifactRoot": self.artifact_root or "",
                    "error": error_text,
                }
            )
        finally:
            remove_temp_files(self.temp_files)

    # ── pause / resume / cancel / cleanup ──────────────────────────────────
    # These five used to live in a `DownloadTaskControl` mixin. There was exactly
    # one subclass and no second base, so the "mixin" was a second file holding a
    # fragment of this class plus a docstring about multiple inheritance that no
    # caller used. Same methods, one file.

    def pause(self):
        """Pause the download by terminating the subprocess."""
        with self.lock:
            if self.state == "paused":
                self.logger.pause(self.id, message="Download is already paused.")
                return {
                    "type": "paused",
                    "id": self.id,
                    "status": "paused",
                    "message": "Download is already paused.",
                }
            if self.state not in {"queued", "running", "starting", "pausing"}:
                return {
                    "type": "control",
                    "id": self.id,
                    "status": self.state,
                    "message": "This download cannot be paused now.",
                }
            self.state = "pausing"
            self.pause_requested.set()
            process = self.process

        self.logger.pause(self.id, message="Pausing download...")
        terminate_process_tree(process)
        return {
            "type": "control",
            "id": self.id,
            "status": "pausing",
            "message": "Pausing download...",
        }

    def resume(self):
        """Resume the download from a paused state."""
        with self.lock:
            if self.state not in {"paused", "pausing"}:
                return {
                    "type": "control",
                    "id": self.id,
                    "status": self.state,
                    "message": "This download is not paused.",
                }
            self.state = "running"
            self.pause_requested.clear()
            self.resume_requested.set()

        return {
            "type": "resumed",
            "id": self.id,
            "status": "running",
            "message": "Resuming download...",
        }

    def cancel(self):
        """Cancel the download by terminating the subprocess."""
        with self.lock:
            if self.state in {"done", "error", "canceled"}:
                return {
                    "type": "control",
                    "id": self.id,
                    "status": self.state,
                    "message": "This download is no longer active.",
                }
            self.state = "canceling"
            self.cancel_requested.set()
            self.pause_requested.clear()
            self.resume_requested.set()
            process = self.process

        terminate_process_tree(process)
        return {
            "type": "control",
            "id": self.id,
            "status": "canceling",
            "message": "Canceling download...",
        }

    def wait_for_resume_or_cancel(self):
        """Block until the download is resumed or canceled. Returns True if resumed."""
        self.resume_requested.clear()
        self.set_state("paused")
        self.send_message(
            {
                "type": "paused",
                "status": "paused",
                "filepath": self.current_path or self.final_path or "",
                "artifactRoot": self.artifact_root or "",
                "message": "Download paused. Resume will continue the partial file when yt-dlp can reuse it.",
            }
        )

        while not self.cancel_requested.is_set():
            if self.resume_requested.wait(0.2):
                self.resume_requested.clear()
                return True
        return False

    def send_canceled(self):
        """Send the canceled state message and clean up artifacts."""
        self.set_state("canceled")
        self.logger.cancel(self.id, message="Download canceled.")
        self.send_message(
            {
                "type": "canceled",
                "status": "canceled",
                "filepath": self.current_path or self.final_path or "",
                "artifactRoot": self.artifact_root or "",
                "message": "Download canceled.",
                **self.cleanup_canceled_artifacts(),
            }
        )

    def cleanup_canceled_artifacts(self):
        """Clean up artifacts after a canceled download."""
        cleanup = {
            "artifactCleanupDeleted": [],
            "artifactCleanupMissing": [],
        }
        artifact_message = self.artifact_message()
        if not artifact_message["path"] and not artifact_message["artifactRoot"]:
            return cleanup

        try:
            targets = unique_delete_targets(artifact_message, Path(self.download_dir).resolve())
        except HostError as exc:
            cleanup["artifactCleanupError"] = str(exc)
            return cleanup

        errors = []
        for target in targets:
            if not target.exists():
                cleanup["artifactCleanupMissing"].append(str(target))
                continue
            try:
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
            except OSError as exc:
                errors.append(f"{target}: {exc}")
                continue
            cleanup["artifactCleanupDeleted"].append(str(target))

        if errors:
            cleanup["artifactCleanupError"] = "; ".join(errors)
        return cleanup
