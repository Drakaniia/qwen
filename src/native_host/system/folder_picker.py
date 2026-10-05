import os
import shutil
import subprocess
from pathlib import Path

from registry import register_handler

from native_paths import default_download_dir, has_unexpanded_env_vars
from native_protocol import HostError, folder_response, send_native_message
from process_control import creation_flags


def initial_folder_for_picker(folder):
    candidates = []
    if folder:
        expanded = os.path.expandvars(os.path.expanduser(str(folder)))
        if not has_unexpanded_env_vars(expanded):
            candidates.append(Path(expanded))
    candidates.append(default_download_dir())
    candidates.append(Path.home())

    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.exists() and resolved.is_dir():
            return str(resolved)
    return ""


def choose_download_folder_with_powershell(initial_folder):
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        raise HostError("PowerShell is not available.")

    script = """
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose Qwin download folder'
$dialog.ShowNewFolderButton = $true
$initial = [Environment]::GetEnvironmentVariable('QWIN_INITIAL_FOLDER')
if ($initial -and [System.IO.Directory]::Exists($initial)) {
  $dialog.SelectedPath = $initial
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $utf8
  [Console]::WriteLine($dialog.SelectedPath)
}
""".strip()
    env = {**os.environ, "QWIN_INITIAL_FOLDER": initial_folder or ""}
    try:
        completed = subprocess.run(
            [powershell, "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            creationflags=creation_flags(),
        )
    except OSError as exc:
        raise HostError(f"Could not start the Windows folder picker: {exc}") from exc

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "").strip()
        raise HostError(details or f"Windows folder picker exited with status {completed.returncode}.")

    selected = (completed.stdout or "").strip()
    return Path(selected).resolve() if selected else None


def choose_download_folder(initial_folder=None):
    return choose_download_folder_with_powershell(initial_folder_for_picker(initial_folder))


@register_handler("chooseFolder")
def handle_choose_folder(message, send=send_native_message):
    selected = choose_download_folder(message.get("initialFolder"))
    send(folder_response(message, selected))
