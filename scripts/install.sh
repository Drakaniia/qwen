#!/usr/bin/env bash
# ============================================================================
# Qwin Video Downloader — Install Script
# ============================================================================
# Replaces install.bat and all 7 PowerShell install scripts with a single
# bash/sh script.  Handles Windows (Git Bash / MSYS2 / WSL) and Unix-likes.
#
# Usage:
#   ./scripts/install.sh               # full install
#   bash scripts/install.sh            # explicit shell
# ============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Bootstrap — make sure we can output errors even before helpers are loaded
# ---------------------------------------------------------------------------
_exec_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$_exec_dir/.." && pwd)"
export ROOT_DIR

# --- colour / decoration helpers ------------------------------------------
if [[ -t 1 ]] && command -v tput &>/dev/null && tput setaf 1 &>/dev/null; then
  _RED=$(tput setaf 1) _GREEN=$(tput setaf 2)
  _YELLOW=$(tput setaf 3) _BLUE=$(tput setaf 4)
  _BOLD=$(tput bold) _RESET=$(tput sgr0)
else
  _RED= _GREEN= _YELLOW= _BLUE= _BOLD= _RESET=
fi

info()  { printf "${_BLUE}%s${_RESET}\n" "$*"; }
ok()    { printf "${_GREEN}✓ %s${_RESET}\n" "$*"; }
warn()  { printf "${_YELLOW}⚠ %s${_RESET}\n" "$*"; }
error() { printf "${_RED}✗ %s${_RESET}\n" "$*"; }
die()   { error "$1"; exit "${2:-1}"; }

header() {
  echo ""
  printf "${_BOLD}${_BLUE}━━━ %s ━━━${_RESET}\n" "$*"
  echo ""
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HOST_NAME="com.qwin.video_downloader"
CHROME_EXTENSION_ID="dbjddokdmkodnkiaccmbjagfalmmmkmi"

TOOLS_DIR="$ROOT_DIR/tools"
HOST_SCRIPT="$ROOT_DIR/src/native_host/host.py"
HOST_LAUNCHER="$ROOT_DIR/src/native_host/qwin_video_host.bat"
NATIVE_DIR="$ROOT_DIR/config/native-host"

CHROME_MANIFEST="$NATIVE_DIR/$HOST_NAME.chrome.json"
YANDEX_MANIFEST="$NATIVE_DIR/$HOST_NAME.yandex.json"

PYTHON_CMD=""
PYTHON_EXE=""

# ---------------------------------------------------------------------------
# OS detection
# ---------------------------------------------------------------------------
is_windows() {
  [[ "${OSTYPE:-}" == msys* || "${OSTYPE:-}" == cygwin* || "${OSTYPE:-}" == mingw* ]] && return 0
  [[ -f /proc/version ]] && grep -qi microsoft /proc/version 2>/dev/null && return 0
  return 1
}

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
check_cmd() {
  command -v "$1" &>/dev/null
}

ensure_dir() {
  mkdir -p "$1"
}

# Run python inline code using the detected Python executable
# Usage:  py_inline <python-code>
py_inline() {
  "$PYTHON_EXE" -c "$@"
}

# Fetch the latest release tag and asset download URL from a public GitHub repo.
# Usage:  fetch_gh_release <user/repo> <asset-name-pattern>
# Output: TAG_NAME<tab>DOWNLOAD_URL  (or empty on failure)
fetch_gh_release() {
  local repo="$1" pattern="$2"
  local api_url="https://api.github.com/repos/$repo/releases/latest"
  local json
  json="$(curl -sfL "$api_url" 2>/dev/null)" || return 1

  local tag url
  tag="$(printf '%s' "$json" | py_inline "import sys,json; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null)" || return 1
  url="$(printf '%s' "$json" | py_inline "
import sys, json, re
data = json.load(sys.stdin)
pat = re.compile('$pattern')
for a in data['assets']:
    if pat.search(a['name']):
        print(a['browser_download_url'])
        break
" 2>/dev/null)" || return 1

  printf '%s\t%s' "$tag" "$url"
}

# Extract a zip file to a destination directory.
# Uses unzip if available, otherwise falls back to Python's zipfile module.
extract_zip() {
  local zip_path="$1" dest_dir="$2"
  if check_cmd unzip; then
    unzip -qo "$zip_path" -d "$dest_dir"
  else
    # Pass paths via env vars to avoid shell/quoting issues with inline Python
    QWIN_ZIP="$zip_path" QWIN_DEST="$dest_dir" "$PYTHON_EXE" -c "
import os, zipfile, sys
try:
    with zipfile.ZipFile(os.environ['QWIN_ZIP']) as z:
        z.extractall(os.environ['QWIN_DEST'])
    sys.exit(0)
except Exception as e:
    print(f'extract failed: {e}', file=sys.stderr)
    sys.exit(1)"
  fi
}

# Download a GitHub release zip, extract it, find a file by name, and copy to dest.
# Usage:  install_gh_release <user/repo> <asset-pattern> <find-file-glob> <dest-dir> <dest-name>
install_gh_release() {
  local repo="$1" pattern="$2" find_glob="$3" dest_dir="$4" dest_name="$5"
  local release_info
  release_info="$(fetch_gh_release "$repo" "$pattern")" || return 1

  local tag download_url
  tag="$(printf '%s' "$release_info" | cut -f1)"
  download_url="$(printf '%s' "$release_info" | cut -f2)"

  local temp_dir
  temp_dir="$(mktemp -d "/tmp/qwin-${repo##*/}-XXXXXXXX")"
  local zip_path="$temp_dir/asset.zip"

  info "  Downloading $download_url ..."
  curl -sLf "$download_url" -o "$zip_path" || { rm -rf "$temp_dir"; return 1; }

  info "  Extracting ..."
  extract_zip "$zip_path" "$temp_dir" || { rm -rf "$temp_dir"; return 1; }

  local found
  found="$(find "$temp_dir" -type f -name "$find_glob" 2>/dev/null | head -1)" || :
  if [[ -z "$found" ]]; then
    rm -rf "$temp_dir"
    return 1
  fi

  ensure_dir "$dest_dir"
  cp "$found" "$dest_dir/$dest_name"
  chmod +x "$dest_dir/$dest_name" 2>/dev/null || true
  rm -rf "$temp_dir"
  ok "$dest_name installed from $tag"
  return 0
}

# Convert a Unix path to a Windows path.
to_win_path() {
  if is_windows; then
    cygpath -w "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

# ---------------------------------------------------------------------------
# PATH repair for MSYS2 / Git Bash
# ---------------------------------------------------------------------------
# MSYS2 puts /mingw64/bin and /usr/bin first on PATH, which can hide Windows
# executables.  We add known Windows tool directories so that node, go, reg,
# powershell, etc. are findable even when the inherited Windows PATH differs.
repair_msys2_path() {
  if is_windows; then
    local added=0
    # Core Windows system directories
    local win_sysdirs=(
      "/c/WINDOWS"
      "/c/WINDOWS/system32"
      "/c/WINDOWS/System32/WindowsPowerShell/v1.0"
      "/c/WINDOWS/System32/Wbem"
      "/c/WINDOWS/System32/OpenSSH"
    )
    for d in "${win_sysdirs[@]}"; do
      if [[ -d "$d" ]] && [[ ":$PATH:" != *":$d:"* ]]; then
        PATH="$d:$PATH"
        ((added++))
      fi
    done

    # Common tool install locations (only if directory exists)
    local tool_dirs=(
      "/c/Program Files/nodejs"
      "/c/Program Files/Go/bin"
      "/c/ProgramData/chocolatey/bin"
    )
    for d in "${tool_dirs[@]}"; do
      if [[ -d "$d" ]] && [[ ":$PATH:" != *":$d:"* ]]; then
        PATH="$PATH:$d"
        ((added++))
      fi
    done

    export PATH
    if [[ $added -gt 0 ]]; then
      : # paths were added to PATH silently
    fi
  fi
}

# ---------------------------------------------------------------------------
# Python detection
# ---------------------------------------------------------------------------
detect_python() {
  # Collect candidates: pair of (command, executable)
  local -a candidates=()

  if check_cmd py;         then candidates+=("py -3" "py"); fi
  if check_cmd python3;    then candidates+=("python3" "python3"); fi
  if check_cmd python;     then candidates+=("python" "python"); fi

  if [[ ${#candidates[@]} -eq 0 ]]; then
    die "Python 3 is not installed or not on PATH."$'\n'"Install Python 3 from https://www.python.org/downloads/windows/ and enable \"Add python.exe to PATH\"."
  fi

  local found=false
  local -i i
  for ((i=0; i<${#candidates[@]}; i+=2)); do
    local cmd="${candidates[i]}"
    local exe="${candidates[i+1]}"
    if eval "$cmd -m pip --version" &>/dev/null 2>&1; then
      PYTHON_CMD="$cmd"
      PYTHON_EXE="$exe"
      found=true
      ok "Using Python: $(eval "$PYTHON_CMD --version 2>&1") [pip available]"
      break
    fi
  done

  if ! $found; then
    # All candidates lack pip — use first candidate anyway (some features will
    # be degraded) but give a clear remediation hint.
    PYTHON_CMD="${candidates[0]}"
    PYTHON_EXE="${candidates[1]}"
    warn "Using Python: $(eval "$PYTHON_CMD --version 2>&1") [pip NOT available]"
    warn "pip is not installed for the detected Python."
    warn "Python packages (yt-dlp, curl-cffi, streamlink, etc.) will NOT be installed."
    warn "To fix, run:  $PYTHON_EXE -m ensurepip --upgrade"
    warn "Then re-run this install script."
  fi
}

# ---------------------------------------------------------------------------
# 1.  Python packages (yt-dlp, curl-cffi, ffmpeg, certifi)
# ---------------------------------------------------------------------------
install_python_packages() {
  header "Python packages"

  info "Installing / updating yt-dlp, curl-cffi, imageio-ffmpeg, certifi ..."
  eval "$PYTHON_CMD -m pip install --upgrade pip \"yt-dlp[default,curl-cffi]\" imageio-ffmpeg certifi" || {
    warn "pip install failed.  Some features may be unavailable."
    return
  }
  ok "Python packages installed"
}

# ---------------------------------------------------------------------------
# 2.  ffmpeg
# ---------------------------------------------------------------------------
install_ffmpeg() {
  header "ffmpeg"

  if check_cmd ffmpeg; then
    ok "ffmpeg is already installed ($(ffmpeg -version 2>&1 | head -1))"
    return
  fi

  if is_windows && check_cmd winget; then
    info "Installing ffmpeg with winget ..."
    winget install --id Gyan.FFmpeg -e --source winget --accept-package-agreements --accept-source-agreements && {
      ok "ffmpeg installed via winget"
      return
    }
  fi

  info "ffmpeg not installed — will use imageio-ffmpeg (bundled via pip) as fallback."
}

# ---------------------------------------------------------------------------
# 4.  aria2
# ---------------------------------------------------------------------------
install_aria2() {
  header "aria2 fast downloader"

  local aria2_dir="$TOOLS_DIR/aria2"
  local aria2_exe="$aria2_dir/aria2c.exe"

  if [[ -f "$aria2_exe" ]]; then
    info "aria2c is already installed ($("$aria2_exe" --version 2>&1 | head -1))"
    return
  fi

  info "Downloading aria2 from GitHub ..."
  if is_windows; then
    if install_gh_release "aria2/aria2" "win-64bit.*\.zip$" "aria2c.exe" "$aria2_dir" "aria2c.exe"; then
      ok "aria2 installed"
    else
      warn "aria2c could not be installed.  Fast segmented mode unavailable."
    fi
  else
    warn "aria2 is not installed.  Install it with your package manager (apt install aria2, brew install aria2, etc.)."
  fi
}

# ---------------------------------------------------------------------------
# 5.  Stream fallbacks  (streamlink + N_m3u8DL-RE)
# ---------------------------------------------------------------------------
install_stream_fallbacks() {
  header "Stream fallback downloaders"

  # streamlink (pip package)
  info "Installing streamlink via pip ..."
  eval "$PYTHON_CMD -m pip install --upgrade streamlink" || {
    warn "streamlink could not be installed."
  }

  # N_m3u8DL-RE
  local nm3u8_dir="$TOOLS_DIR/n_m3u8dl-re"
  local nm3u8_exe="$nm3u8_dir/N_m3u8DL-RE.exe"

  if [[ -f "$nm3u8_exe" ]]; then
    info "N_m3u8DL-RE already installed"
    return
  fi

  if is_windows; then
    local arch="win-x64"
    case "${PROCESSOR_ARCHITECTURE:-}" in
      ARM64|ARM) arch="win-arm64" ;;
      x86|X86)   arch="win-NT6.0-x86" ;;
    esac
    if [[ "${PROCESSOR_ARCHITEW6432:-}" == "ARM64" ]]; then arch="win-arm64"; fi

    info "Downloading N_m3u8DL-RE (${arch}) from GitHub ..."
    if install_gh_release "nilaoda/N_m3u8DL-RE" "(?i)_${arch}_[^_].*\.zip$" "N_m3u8DL-RE.exe" "$nm3u8_dir" "N_m3u8DL-RE.exe"; then
      ok "N_m3u8DL-RE installed"
    else
      warn "N_m3u8DL-RE could not be installed.  Stream-only fallbacks may be unavailable."
    fi
  else
    warn "N_m3u8DL-RE is a Windows tool.  Skipping on this platform."
  fi
}

# ---------------------------------------------------------------------------
# 6.  Build extension  (delegates to scripts/build-extension.ps1)
# ---------------------------------------------------------------------------
build_extension() {
  header "Building browser extension"

  local ps_builder="$ROOT_DIR/scripts/build-extension.ps1"

  if is_windows && check_cmd powershell; then
    if powershell -NoProfile -ExecutionPolicy Bypass -File "$ps_builder" -Target "${1:-all}"; then
      ok "Extension built"
      return
    fi
    warn "PowerShell build failed.  Is Node.js on PATH?"
    return
  fi

  warn "Extension build requires Windows + PowerShell."
  warn "Run 'npm run build' (scripts\\build-extension.ps1) after installing Node.js."
}

# ---------------------------------------------------------------------------
# 7.  Register native messaging hosts
# ---------------------------------------------------------------------------
register_native_hosts() {
  header "Native messaging host registration"

  ensure_dir "$NATIVE_DIR"

  # ── Write manifest JSON files ────────────────────────────────────────────
  # Try PowerShell first on Windows; fall back to Python on any platform.

  local manifests_written=false

  if is_windows && check_cmd powershell; then
    local win_launcher
    win_launcher="$(to_win_path "$HOST_LAUNCHER")"
    local win_chrome_manifest
    win_chrome_manifest="$(to_win_path "$CHROME_MANIFEST")"
    local win_yandex_manifest
    win_yandex_manifest="$(to_win_path "$YANDEX_MANIFEST")"

    if powershell -NoProfile -Command "
\$ErrorActionPreference = 'Stop'
\$chromePath = '$win_chrome_manifest'
\$yandexPath = '$win_yandex_manifest'
\$launcher = '$win_launcher'
\$hostName = '$HOST_NAME'
\$chromeId = '$CHROME_EXTENSION_ID'

\$chrome = [ordered]@{
  name            = \$hostName
  description     = 'Qwin Video Downloader native host'
  path            = \$launcher
  type            = 'stdio'
  allowed_origins = @('chrome-extension://' + \$chromeId + '/')
}
\$utf8 = New-Object System.Text.UTF8Encoding \$false
[System.IO.File]::WriteAllText(\$chromePath, (\$chrome | ConvertTo-Json -Depth 5), \$utf8)
[System.IO.File]::WriteAllText(\$yandexPath, (\$chrome | ConvertTo-Json -Depth 5), \$utf8)
Write-Output 'Manifest files written'
" 2>&1; then
      manifests_written=true
      ok "Manifest files written"
    else
      warn "PowerShell could not write manifest files.  Falling back to Python..."
    fi
  fi

  if ! $manifests_written; then
    py_inline "
import json, os

host_name = '$HOST_NAME'
chrome_id = '$CHROME_EXTENSION_ID'
launcher = '$HOST_LAUNCHER'
native_dir = '$NATIVE_DIR'

chrome = {
    'name': host_name,
    'description': 'Qwin Video Downloader native host',
    'path': launcher,
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://' + chrome_id + '/']
}

for fname, data in [('$HOST_NAME.chrome.json', chrome), ('$HOST_NAME.yandex.json', chrome)]:
    os.makedirs(native_dir, exist_ok=True)
    with open(os.path.join(native_dir, fname), 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
print('Manifest files written')
" || {
      warn "Could not write native messaging manifest files."
      return
    }
    ok "Manifest files written"
  fi

  # ── Register in Windows Registry ────────────────────────────────────────
  if ! is_windows; then
    info "Skipping Windows Registry registration (non-Windows OS)."
    return
  fi

  local win_launcher
  win_launcher="$(to_win_path "$HOST_LAUNCHER")"
  local win_manifest_chrome
  win_manifest_chrome="$(to_win_path "$CHROME_MANIFEST")"
  local win_manifest_yandex
  win_manifest_yandex="$(to_win_path "$YANDEX_MANIFEST")"

  local registered_via=""

  # Try PowerShell (preferred) — avoids MSYS2 path-mangling issues.
  if check_cmd powershell; then
    if powershell -NoProfile -Command "
\$hostName = '$HOST_NAME'
\$chromeManifest = '$win_manifest_chrome'
\$yandexManifest = '$win_manifest_yandex'
\$launcher = '$win_launcher'
\$chromeId = '$CHROME_EXTENSION_ID'

\$browsers = @(
    @{ Name = 'Chrome';  RegPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + \$hostName;  Manifest = \$chromeManifest },
    @{ Name = 'Edge';    RegPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + \$hostName;  Manifest = \$chromeManifest },
    @{ Name = 'Brave';   RegPath = 'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\' + \$hostName;  Manifest = \$chromeManifest },
    @{ Name = 'Chromium'; RegPath = 'HKCU:\Software\Chromium\NativeMessagingHosts\' + \$hostName;  Manifest = \$yandexManifest },
    @{ Name = 'Yandex';  RegPath = 'HKCU:\Software\Yandex\YandexBrowser\NativeMessagingHosts\' + \$hostName;  Manifest = \$yandexManifest }
)

\$registered = 0
foreach (\$b in \$browsers) {
    \$parent = Split-Path \$b.RegPath -Parent
    if (-not (Test-Path \$parent)) {
        \$null = New-Item -Path \$parent -Force 2>\$null
    }
    if (Test-Path \$b.RegPath) {
        Set-Item -Path \$b.RegPath -Value \$b.Manifest -ErrorAction SilentlyContinue 2>\$null
    } else {
        \$null = New-Item -Path \$b.RegPath -Value \$b.Manifest -Force -ErrorAction SilentlyContinue 2>\$null
    }
    if (\$?) { \$registered++ } else { Write-Warning \"Could not register \$('\"' + \$b.Name + '\"') native messaging host.\" }
}

if (\$registered -gt 0) {
    Write-Output \"Registered native host for \$registered browser(s).\"
} else {
    Write-Warning \"No browsers were registered. Install Chrome/Edge/Brave/Yandex and re-run.\"
    exit 1
}
" 2>&1; then
      registered_via="PowerShell"
    else
      warn "PowerShell registry registration failed.  Trying reg.exe fallback..."
    fi
  else
    warn "PowerShell not found.  Trying reg.exe fallback..."
  fi

  # Fallback: reg.exe (with MSYS2_ARG_CONV_EXCL to prevent path mangling)
  if [[ -z "$registered_via" ]]; then
    local win_manifest
    win_manifest="$win_manifest_chrome"
    local any_registered=false

    MSYS2_ARG_CONV_EXCL='*' reg.exe add "HKCU\Software\Google\Chrome\NativeMessagingHosts\$HOST_NAME" /ve /t REG_SZ /d "$win_manifest" /f &>/dev/null && any_registered=true
    MSYS2_ARG_CONV_EXCL='*' reg.exe add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$HOST_NAME" /ve /t REG_SZ /d "$win_manifest" /f &>/dev/null && any_registered=true
    MSYS2_ARG_CONV_EXCL='*' reg.exe add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HOST_NAME" /ve /t REG_SZ /d "$win_manifest" /f &>/dev/null && any_registered=true
    MSYS2_ARG_CONV_EXCL='*' reg.exe add "HKCU\Software\Chromium\NativeMessagingHosts\$HOST_NAME" /ve /t REG_SZ /d "$win_manifest_yandex" /f &>/dev/null && any_registered=true
    MSYS2_ARG_CONV_EXCL='*' reg.exe add "HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\$HOST_NAME" /ve /t REG_SZ /d "$win_manifest_yandex" /f &>/dev/null && any_registered=true

    if $any_registered; then
      registered_via="reg.exe"
    else
      warn "No browsers were registered.  Install Chrome/Edge/Brave/Yandex and re-run."
    fi
  fi

  if [[ -n "$registered_via" ]]; then
    ok "Native host registered via $registered_via"
  fi
}

# ============================================================================
# Main
# ============================================================================
main() {
  echo ""
  echo "${_BOLD}Qwin Video Downloader — Install Script${_RESET}"
  echo "${_BLUE}=========================================${_RESET}"
  echo ""

  # --- pre-flight checks ---
  if [[ ! -f "$HOST_SCRIPT" ]]; then
    die "src/native_host/host.py was not found at: $HOST_SCRIPT"
  fi
  if [[ ! -f "$HOST_LAUNCHER" ]]; then
    die "src/native_host/qwin_video_host.bat was not found at: $HOST_LAUNCHER"
  fi
  ok "Source files verified"

  if ! check_cmd curl; then
    die "curl is required but not found in PATH."
  fi
  ok "curl verified"

  if ! check_cmd unzip; then
    info "unzip not found — will use Python's zipfile module for extraction."
  fi

  # --- PATH repair for MSYS2 ---
  repair_msys2_path

  # --- main flow ---
  detect_python
  install_python_packages
  install_ffmpeg
  install_aria2
  install_stream_fallbacks
  build_extension
  register_native_hosts

  # --- summary ---
  echo ""
  echo "${_BOLD}${_GREEN}══════════════════════════════════════════════════════════════${_RESET}"
  echo "${_GREEN}  Installation complete!${_RESET}"
  echo "${_GREEN}  Restart your browser after loading or reloading the extension.${_RESET}"
  echo ""
  echo "  Chrome extension ID expected:  $CHROME_EXTENSION_ID"
  echo "  Yandex extension ID expected:  $CHROME_EXTENSION_ID"
  echo ""
  echo "  Tools installed in: $TOOLS_DIR"
  echo "${_BOLD}${_GREEN}══════════════════════════════════════════════════════════════${_RESET}"
  echo ""
}

main "$@"
