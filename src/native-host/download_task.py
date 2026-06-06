import subprocess
import shutil
import threading
import errno
from collections import deque
from pathlib import Path

from artifacts import unique_delete_targets
from browser_context import remove_temp_files
from native_protocol import HostError, send_native_message
from process_control import creation_flags, terminate_process_tree
from progress_parser import is_aria2_access_refusal, iter_process_output_lines, parse_yt_dlp_line
from stream_backends import is_retryable_backend_error


class DownloadTask:
    def __init__(
        self,
        message,
        command,
        download_dir,
        send=send_native_message,
        fallback_command=None,
        fallback_commands=None,
        temp_files=None,
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

    def cleanup_canceled_artifacts(self):
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

    def send_canceled(self):
        self.set_state("canceled")
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

    def pause(self):
        with self.lock:
            if self.state == "paused":
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

        terminate_process_tree(process)
        return {
            "type": "control",
            "id": self.id,
            "status": "pausing",
            "message": "Pausing download...",
        }

    def resume(self):
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
                self.recent_lines.append(parsed.get("line", ""))
            self.send_message({"type": "progress", **parsed})

        exit_code = process.wait()
        with self.lock:
            if self.process is process:
                self.process = None
        return exit_code

    def fallback_attempts(self):
        attempts = [{"command": self.command, "label": "yt-dlp"}]
        if self.fallback_command:
            attempts.append({"command": self.fallback_command, "label": "standard mode", "aria2_fallback": True})
        attempts.extend(self.fallback_commands)
        return attempts

    def wait_for_resume_or_cancel(self):
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

    def run(self):
        try:
            attempt = 0
            attempts = self.fallback_attempts()
            attempt_index = 0
            while True:
                if self.cancel_requested.is_set():
                    self.send_canceled()
                    return

                attempt += 1
                self.send_message(
                    {
                        "type": "started",
                        "status": "running",
                        "message": (
                            f"Saving to {self.download_dir}"
                            if attempt == 1
                            else "Resuming download from partial files..."
                        ),
                    }
                )
                active_meta = attempts[attempt_index]
                self.active_command_meta = active_meta
                exit_code = self.run_process_once(active_meta["command"])

                if self.cancel_requested.is_set():
                    self.send_canceled()
                    return

                if self.pause_requested.is_set():
                    if not self.wait_for_resume_or_cancel():
                        self.send_canceled()
                        return
                    continue

                if exit_code != 0:
                    details = "\n".join(item for item in self.recent_lines if item).strip()
                    if not details:
                        details = f"yt-dlp exited with status {exit_code}."
                    next_index = None
                    next_meta = None
                    can_retry_aria2 = False
                    for candidate_index in range(attempt_index + 1, len(attempts)):
                        candidate = attempts[candidate_index]
                        if candidate.get("aria2_fallback"):
                            if is_aria2_access_refusal(details):
                                next_index = candidate_index
                                next_meta = candidate
                                can_retry_aria2 = True
                                break
                            continue
                        if is_retryable_backend_error(details):
                            next_index = candidate_index
                            next_meta = candidate
                            break
                    if next_meta is not None:
                        attempt_index = next_index
                        self.recent_lines.clear()
                        label = str(next_meta.get("label") or "another downloader")
                        line = (
                            "Fast downloader was refused by the server; retrying in standard mode."
                            if can_retry_aria2
                            else f"yt-dlp could not use this source; retrying with {label}."
                        )
                        self.send_message(
                            {
                                "type": "progress",
                                "stage": "log",
                                "line": line,
                            }
                        )
                        continue
                    raise HostError(details)

                final_path = active_meta.get("final_path")
                artifact_root = active_meta.get("artifact_root")
                if final_path and not self.final_path:
                    self.final_path = final_path
                if artifact_root and not self.artifact_root:
                    self.artifact_root = artifact_root
                self.set_state("done")
                self.send_message(
                    {
                        "type": "done",
                        "status": "done",
                        "filepath": self.final_path,
                        "artifactRoot": self.artifact_root or (str(Path(self.final_path).parent) if self.final_path else ""),
                        "message": "Download complete.",
                    }
                )
                return
        except HostError as exc:
            if self.cancel_requested.is_set():
                self.send_canceled()
            else:
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
            self.set_state("error")
            self.send_message(
                {
                    "type": "error",
                    "status": "error",
                    "filepath": self.current_path or self.final_path or "",
                    "artifactRoot": self.artifact_root or "",
                    "error": f"Unexpected helper error: {exc}",
                }
            )
        finally:
            remove_temp_files(self.temp_files)
