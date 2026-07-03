import errno
import shutil
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

from download_logger import get_logger
from download_task_control import DownloadTaskControl
from fix_mp4_codec import fix_mp4_codec_metadata, needs_codec_fix

from browser_context import remove_temp_files
from native_protocol import HostError, send_native_message
from process_control import creation_flags
from progress_parser import is_cloudflare_challenge, iter_process_output_lines, parse_yt_dlp_line


class DownloadTask(DownloadTaskControl):
    def __init__(
        self,
        message,
        command,
        download_dir,
        send=send_native_message,
        fallback_command=None,
        fallback_commands=None,
        temp_files=None,
        logger=None,
    ):
        self.message = message
        self.command = command
        self.fallback_command = fallback_command
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
        self.final_path = None
        self.current_path = None
        self.artifact_root = None
        self.recent_lines = deque(maxlen=25)
        self.thread = None
        self.active_command_meta = None
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

    def send_message(self, message):
        if self.output_disconnected:
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
            process = subprocess.Popen(
                active_command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                cwd=str(self.download_dir),
                creationflags=creation_flags(),
            )
        except OSError as exc:
            raise HostError(f"Could not start yt-dlp: {exc}") from exc

        with self.lock:
            self.process = process
            self.state = "running"

        assert process.stdout is not None
        for line in iter_process_output_lines(process.stdout):
            parsed = parse_yt_dlp_line(line)
            if parsed.get("filepath"):
                self.current_path = parsed["filepath"]
            if parsed.get("artifactRoot"):
                self.artifact_root = parsed["artifactRoot"]
            if parsed["stage"] == "filepath":
                self.final_path = parsed["filepath"]
            else:
                line_text = parsed.get("line", "")
                self.recent_lines.append(line_text)
                # Feed every line to the download logger (full output capture)
                self.logger.attempt_line(self.id, line_text)
            self.send_message({"type": "progress", **parsed})

        exit_code = process.wait()
        with self.lock:
            if self.process is process:
                self.process = None
        return exit_code

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
        attempts = [{"command": self.command, "label": "yt-dlp"}]
        if self.fallback_command:
            attempts.append({"command": self.fallback_command, "label": "yt-dlp"})
        attempts.extend(self.fallback_commands)
        return attempts

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
                        "message": (
                            f"Saving to {self.download_dir}"
                            if attempt_num == 1
                            else "Resuming download from partial files..."
                        ),
                    }
                )
                exit_code = self.run_process_once(active_meta["command"])

                self.logger.attempt_end(
                    download_id=self.id,
                    attempt_num=attempt_num,
                    exit_code=exit_code,
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

                    # ── Post-processing: fix mp4v→avc1 codec metadata ──────
                    if self.final_path and self.final_path.lower().endswith((".mp4", ".m4v")):
                        try:
                            if needs_codec_fix(self.final_path):
                                self.logger.attempt_line(self.id, f"Fixing mp4v→avc1 codec metadata: {self.final_path}")
                                result = fix_mp4_codec_metadata(self.final_path, backup=False)
                                if result.get("fixed"):
                                    sps = result.get("spsCount", 0)
                                    pps = result.get("ppsCount", 0)
                                    self.logger.attempt_line(
                                        self.id,
                                        f"Codec fix applied (SPS={sps}, PPS={pps})",
                                    )
                                elif result.get("warning"):
                                    self.logger.attempt_line(self.id, f"Codec fix warning: {result['warning']}")
                        except Exception as exc:
                            # Never fail the download because of a post-processing issue
                            self.logger.attempt_line(self.id, f"Codec fix error (non-fatal): {exc}")

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

                # Try the next fallback command unconditionally
                attempt_index += 1
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
                        }
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
