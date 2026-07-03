"""Download task control mixin — pause, resume, cancel, and cleanup operations.

Extracted from download_task.py for modularity. This mixin is designed to
be used as a base class alongside DownloadTask via multiple inheritance.

Usage:

    class DownloadTask(DownloadTaskControl, ...):
        ...
"""

import shutil
from pathlib import Path

from artifacts import unique_delete_targets
from native_protocol import HostError
from process_control import terminate_process_tree


class DownloadTaskControl:
    """Mixin providing pause/resume/cancel/cleanup for download tasks.

    Expects the following attributes on ``self`` (set by ``DownloadTask.__init__``):
    - id, lock, state, pause_requested, resume_requested, cancel_requested
    - process, logger, send, current_path, final_path, artifact_root
    - download_dir, output_disconnected
    """

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
