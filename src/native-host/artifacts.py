import os
import shutil
import subprocess
from pathlib import Path

from native_paths import default_download_dir, resolve_download_dir
from native_protocol import HostError, send_native_message
from yt_dlp_adapter import creation_flags


def build_open_path_command(path, reveal=False):
    target = Path(path)
    if os.name == "nt":
        if reveal:
            return ["explorer.exe", "/select,", str(target)]
        return None

    opener = "open" if os.sys.platform == "darwin" else "xdg-open"
    return [opener, str(target.parent if reveal else target)]


def open_download_path(message, reveal=False):
    request_id = str(message.get("id") or message.get("requestId") or "")
    raw_path = str(message.get("path") or message.get("filepath") or "").strip()
    if not raw_path:
        raise HostError("No downloaded file path is available for this item.")

    target = Path(os.path.expandvars(os.path.expanduser(raw_path))).resolve()
    if not target.exists():
        parent = target.parent
        if reveal and parent.exists():
            target = parent
            reveal = False
        else:
            raise HostError(f"Downloaded file no longer exists: {target}")

    command = build_open_path_command(target, reveal=reveal)
    if command is None:
        try:
            os.startfile(str(target))  # type: ignore[attr-defined]
        except OSError as exc:
            raise HostError(f"Could not open downloaded file: {exc}") from exc
    else:
        try:
            subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=creation_flags(),
            )
        except OSError as exc:
            raise HostError(f"Could not open downloaded file location: {exc}") from exc

    send_native_message({"type": "opened", "id": request_id, "path": str(target)})


def resolve_artifact_path(value):
    return Path(os.path.expandvars(os.path.expanduser(str(value)))).resolve()


def path_is_relative_to(path, root):
    try:
        Path(path).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def is_dangerous_delete_target(target, allowed_root=None):
    if not target or target.parent == target:
        return True
    if allowed_root and target == allowed_root:
        return True

    lowered_name = target.name.lower()
    dangerous_names = {
        "",
        ".",
        "..",
        "downloads",
        "desktop",
        "documents",
        "videos",
        "music",
        "pictures",
    }
    if lowered_name in dangerous_names:
        return True

    try:
        if target == Path.home().resolve() or target == default_download_dir().resolve():
            return True
    except OSError:
        pass

    return False


def validate_delete_target(target, allowed_root):
    if not path_is_relative_to(target, allowed_root):
        raise HostError(f"Refusing to delete outside the configured download folder: {target}")
    if is_dangerous_delete_target(target, allowed_root):
        raise HostError(f"Refusing to delete unsafe download artifact target: {target}")


def should_delete_parent_folder_for_file(path):
    parent = path.parent
    if is_dangerous_delete_target(parent):
        return False

    parent_name = parent.name.lower()
    file_stem = path.stem.lower()
    return bool(parent_name and (file_stem.startswith(parent_name) or parent_name in file_stem))


def unique_delete_targets(message, allowed_root=None):
    roots = []
    for key in ["artifactRoot", "artifactDir", "outputDirectory"]:
        value = message.get(key)
        if value:
            roots.append(resolve_artifact_path(value))

    raw_paths = []
    for key in ["path", "filepath"]:
        value = message.get(key)
        if value:
            raw_paths.append(resolve_artifact_path(value))
    for value in message.get("artifactPaths") or []:
        if value:
            raw_paths.append(resolve_artifact_path(value))

    if not roots:
        for path in raw_paths:
            roots.append(path.parent if should_delete_parent_folder_for_file(path) else path)

    candidates = []
    for target in roots:
        if allowed_root:
            validate_delete_target(target, allowed_root)
        if is_dangerous_delete_target(target, allowed_root):
            continue
        if target not in candidates:
            candidates.append(target)

    candidates.sort(key=lambda item: len(item.parts))
    collapsed = []
    for target in candidates:
        if any(parent == target or parent in target.parents for parent in collapsed):
            continue
        collapsed.append(target)
    return collapsed


def delete_download_artifacts(message, send=send_native_message):
    request_id = str(message.get("id") or message.get("requestId") or "")
    deleted = []
    missing = []
    allowed_root = resolve_download_dir(message.get("downloadFolder"))

    for target in unique_delete_targets(message, allowed_root):
        if not target.exists():
            missing.append(str(target))
            continue
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except OSError as exc:
            raise HostError(f"Could not delete downloaded artifacts at {target}: {exc}") from exc
        deleted.append(str(target))

    send({"type": "deletedArtifacts", "id": request_id, "deleted": deleted, "missing": missing})
