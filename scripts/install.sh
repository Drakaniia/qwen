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
FIREFOX_EXTENSION_ID="qwin-video-downloader@example.com"

TOOLS_DIR="$ROOT_DIR/tools"
HOST_SCRIPT="$ROOT_DIR/src/native_host/host.py"
HOST_LAUNCHER="$ROOT_DIR/src/native_host/qwin_video_host.bat"
NATIVE_DIR="$ROOT_DIR/config/native-host"

CHROME_MANIFEST="$NATIVE_DIR/$HOST_NAME.chrome.json"
YANDEX_MANIFEST="$NATIVE_DIR/$HOST_NAME.yandex.json"
FIREFOX_MANIFEST="$NATIVE_DIR/$HOST_NAME.firefox.json"

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
# Python detection
# ---------------------------------------------------------------------------
detect_python() {
  if check_cmd py; then
    PYTHON_CMD="py -3"
    PYTHON_EXE="py"
  elif check_cmd python3; then
    PYTHON_CMD="python3"
    PYTHON_EXE="python3"
  elif check_cmd python; then
    PYTHON_CMD="python"
    PYTHON_EXE="python"
  else
    die "Python 3 is not installed or not on PATH."$'\n'"Install Python 3 from https://www.python.org/downloads/windows/ and enable \"Add python.exe to PATH\"."
  fi
  ok "Using Python: $(eval "$PYTHON_CMD --version 2>&1")"
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
# 2.  Verify curl_cffi
# ---------------------------------------------------------------------------
verify_curl_cffi() {
  header "curl_cffi verification"

  if eval "$PYTHON_CMD \"$ROOT_DIR/scripts/check_curl_cffi.py\""; then
    ok "curl_cffi is available"
  else
    warn "curl_cffi did not import correctly."
    warn "Direct download fallback will use standard HTTP (less effective behind CDNs/WAFs)."
    warn "Re-run install.sh or manually: pip install \"yt-dlp[default,curl-cffi]\" --upgrade"
  fi
}

# ---------------------------------------------------------------------------
# 3.  ffmpeg
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
# 4.  Gopeed  (requires Go 1.21+)
# ---------------------------------------------------------------------------
install_gopeed() {
  header "Gopeed download manager"

  if ! check_cmd go; then
    warn "Go is not installed.  Gopeed requires Go 1.21+."
    warn "Install Go from https://go.dev/dl/ then re-run this script."
    warn "BitTorrent and magnet downloads will use aria2c instead."
    return
  fi

  local go_ver
  go_ver="$(go version | grep -oP 'go\K\d+\.\d+')" || true
  if [[ -n "$go_ver" ]]; then
    local major="${go_ver%.*}" minor="${go_ver#*.}"
    if (( major == 1 && minor < 21 )); then
      warn "Go version $go_ver is too old.  Gopeed requires Go 1.21+."
      warn "Update Go from https://go.dev/dl/ then re-run."
      return
    fi
  fi

  info "Installing Gopeed via 'go install' ..."
  go install github.com/GopeedLab/gopeed/cmd/gopeed@latest 2>&1 || {
    warn "Gopeed installation failed.  BitTorrent/magnet will use aria2c."
    return
  }

  local gopath
  gopath="$(go env GOPATH)"
  local gopeed_bin="$gopath/bin/gopeed"
  if is_windows; then gopeed_bin="$gopath/bin/gopeed.exe"; fi

  if [[ -f "$gopeed_bin" ]]; then
    if is_windows; then
      powershell -Command "[Environment]::SetEnvironmentVariable('QWIN_GOPEED', '$(to_win_path "$gopeed_bin")', 'User')" 2>/dev/null || true
    fi
    ok "Gopeed installed to $gopeed_bin"
  else
    warn "Gopeed was installed but the binary was not found at $gopeed_bin."
    warn "Check your GOPATH/bin directory."
  fi
}

# ---------------------------------------------------------------------------
# 5.  aria2
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
# 6.  Stream fallbacks  (streamlink + N_m3u8DL-RE)
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
# 7.  you-get & lux
# ---------------------------------------------------------------------------
install_you_get_lux() {
  header "you-get & lux fallback downloaders"

  # --- you-get (pip) ---
  info "Installing you-get via pip ..."
  if eval "$PYTHON_CMD -m pip install --upgrade you-get"; then
    ok "you-get installed"
  else
    warn "you-get could not be installed via pip."
  fi

  # --- lux (Go binary, install via go install) ---
  # Note: lux (iawia002/lux) no longer provides Windows release binaries on GitHub.
  # We install via 'go install' since Go is already a project dependency.
  if check_cmd lux && lux --version &>/dev/null; then
    ok "lux already available on PATH"
    return
  fi

  if ! check_cmd go; then
    warn "Go is not installed.  Cannot install lux ('go install github.com/iawia002/lux@latest')."
    warn "Asian platform downloads (Bilibili, Douyin, etc.) will use yt-dlp instead."
    return
  fi

  info "Installing lux via 'go install github.com/iawia002/lux@latest' ..."
  go install github.com/iawia002/lux@latest 2>&1 || {
    warn "lux could not be installed via go install."
    warn "Asian platform downloads (Bilibili, Douyin, etc.) will use yt-dlp instead."
    return
  }

  local gopath
  gopath="$(go env GOPATH)"
  local lux_bin="$gopath/bin/lux"
  if is_windows; then lux_bin="$gopath/bin/lux.exe"; fi

  local lux_dir="$TOOLS_DIR/lux"
  local lux_exe="$lux_dir/lux.exe"

  if [[ -f "$lux_bin" ]]; then
    ensure_dir "$lux_dir"
    cp "$lux_bin" "$lux_exe"
    if "$lux_exe" --version &>/dev/null; then
      ok "lux installed to tools/lux/"
    else
      # Copy didn't work, use the GOPATH version directly
      rm -f "$lux_exe"
      ok "lux installed at $lux_bin"
    fi
  else
    warn "lux binary not found at expected location: $lux_bin"
    warn "It may be on PATH after adding GOPATH/bin to your PATH."
  fi
}

# ---------------------------------------------------------------------------
# 8.  qwin-capture  (Go companion binary)
# ---------------------------------------------------------------------------
install_capture_binary() {
  header "Go companion binary (qwin-capture)"

  local capture_dir="$TOOLS_DIR/capture"
  local capture_exe="$capture_dir/qwin-capture.exe"
  local go_source_dir="$ROOT_DIR/go"

  # Check existing binary in tools/
  if [[ -f "$capture_exe" ]]; then
    if "$capture_exe" --version &>/dev/null; then
      local ver="$("$capture_exe" --version 2>&1 | head -1)"
      ok "qwin-capture already installed and working ($ver)"
      return
    fi
    warn "Existing qwin-capture.exe is not runnable.  Rebuilding..."
    rm -f "$capture_exe"
  fi

  if ! check_cmd go; then
    warn "Go is not installed.  Cannot build qwin-capture from source."
    warn "CDM capture and screen recording features will be unavailable."
    return
  fi

  # Check for a pre-built binary shipped in the go/ directory
  if [[ -f "$go_source_dir/qwin-capture.exe" ]]; then
    if "$go_source_dir/qwin-capture.exe" --version &>/dev/null; then
      local prebuilt_ver="$("$go_source_dir/qwin-capture.exe" --version 2>&1 | head -1)"
      info "Found pre-built qwin-capture in go/: $prebuilt_ver"
      ensure_dir "$capture_dir"
      cp "$go_source_dir/qwin-capture.exe" "$capture_exe"
      ok "qwin-capture installed from pre-built binary ($prebuilt_ver)"
      return
    fi
  fi

  # Build from Go source in go/
  if [[ ! -f "$go_source_dir/main.go" ]]; then
    warn "Go source not found at $go_source_dir.  Cannot build qwin-capture."
    warn "CDM capture and screen recording features will be unavailable."
    return
  fi

  ensure_dir "$capture_dir"
  info "Building qwin-capture from Go source in go/ ..."
  (cd "$go_source_dir" && go build -o "$capture_exe" .) 2>&1 || {
    warn "Failed to build qwin-capture from source."
    warn "CDM capture and screen recording features will be unavailable."
    return
  }

  if [[ -f "$capture_exe" ]]; then
    if "$capture_exe" --version &>/dev/null; then
      local built_ver="$("$capture_exe" --version 2>&1 | head -1)"
      ok "qwin-capture built and installed ($built_ver)"
    else
      rm -f "$capture_exe"
      warn "Built qwin-capture.exe is not runnable."
    fi
  else
    warn "Build produced no output file."
  fi
}

# ---------------------------------------------------------------------------
# 9.  Widevine CDM
# ---------------------------------------------------------------------------
install_cdm() {
  header "Widevine CDM"

  local cdm_dir="$TOOLS_DIR/cdm"
  local cdm_dll="$cdm_dir/widevinecdm.dll"
  local cdm_manifest="$cdm_dir/manifest.json"
  local cdm_version_file="$cdm_dir/version.txt"
  local cdm_status_file="$cdm_dir/status.json"

  # No hardcoded compatible versions list — any Chrome-bundled CDM is accepted.
  # There is no reliable standalone CDM download source; the CDM is always
  # sourced from Chrome/Chromium/Edge/Brave if available.

  write_cdm_status() {
    local available="$1" version="$2" source="$3" error="${4:-}"
    local cdm_path_escaped
    cdm_path_escaped="$(to_win_path "$cdm_dir" | sed 's/\\/\\\\/g')"
    local error_escaped
    error_escaped="$(printf '%s' "$error" | sed "s/'/'\\\\''/g")"
    local timestamp
    timestamp="$(date +%Y-%m-%dT%H:%M:%S%z 2>/dev/null || date -Iseconds 2>/dev/null || echo "unknown")"

    py_inline "
import json
status = {
    'cdmAvailable': $available,
    'cdmVersion': '$version',
    'cdmSource': '$source',
    'cdmPath': '$cdm_path_escaped',
    'l1Only': False,
    'error': '$error_escaped',
    'installedAt': '$timestamp'
}
with open('$cdm_status_file', 'w', encoding='utf-8') as f:
    json.dump(status, f, indent=2)
" 2>/dev/null || true
  }

  ensure_dir "$TOOLS_DIR"

  # --- detect browser-bundled CDM ---
  # Chrome installs Widevine CDM automatically when first DRM content is played.
  # We search all Chromium-based browsers for the CDM.
  local found_cdm_dll="" found_cdm_ver="" found_cdm_manifest="" found_cdm_source=""

  if is_windows; then
    local local_app_data="${LOCALAPPDATA:-$(cmd //c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')}"
    local browser_candidates=(
      "$local_app_data/Google/Chrome/User Data/WidevineCdm:chrome"
      "$local_app_data/Google/Chrome Beta/User Data/WidevineCdm:chrome-beta"
      "$local_app_data/Google/Chrome SxS/User Data/WidevineCdm:chrome-canary"
      "$local_app_data/Chromium/User Data/WidevineCdm:chromium"
      "$local_app_data/Microsoft/Edge/User Data/WidevineCdm:edge"
      "$local_app_data/BraveSoftware/Brave-Browser/User Data/WidevineCdm:brave"
      "$local_app_data/Yandex/YandexBrowser/User Data/WidevineCdm:yandex"
    )

    for entry in "${browser_candidates[@]}"; do
      local base="${entry%%:*}"
      local browser="${entry##*:}"
      [[ -d "$base" ]] || continue

      local ver_dir
      ver_dir="$(find "$base" -maxdepth 1 -type d -name '[0-9]*' 2>/dev/null | sort -rV | head -1)" || continue
      [[ -z "$ver_dir" ]] && continue

      local dll="$ver_dir/widevinecdm.dll"
      if [[ -f "$dll" ]]; then
        found_cdm_dll="$dll"
        found_cdm_ver="$(basename "$ver_dir")"
        found_cdm_source="$browser"
        [[ -f "$ver_dir/manifest.json" ]] && found_cdm_manifest="$ver_dir/manifest.json"
        break
      fi
    done
  fi

  if [[ -n "$found_cdm_dll" ]]; then
    info "Found Widevine CDM in $found_cdm_source: version $found_cdm_ver"
    ensure_dir "$cdm_dir"
    cp "$found_cdm_dll" "$cdm_dll"
    [[ -n "$found_cdm_manifest" ]] && cp "$found_cdm_manifest" "$cdm_manifest"
    printf '%s' "$found_cdm_ver" > "$cdm_version_file"
    write_cdm_status true "$found_cdm_ver" "$found_cdm_source"
    ok "Widevine CDM installed to tools/cdm/ (source: $found_cdm_source, v$found_cdm_ver)"
    return
  else
    info "No Widevine CDM found in any installed browser."
    info "Chrome downloads the CDM automatically when you first play a DRM video."
    info "Visit a site with DRM content (e.g. Netflix, Disney+) in Chrome, then re-run this script."
    write_cdm_status false "" "" "No browser-bundled Widevine CDM found. Play DRM content in Chrome first."
  fi
}

# ---------------------------------------------------------------------------
# 10.  Build extension  (replaces build-extension.ps1)
# ---------------------------------------------------------------------------
build_extension() {
  header "Building browser extension"

  local dist_root="$ROOT_DIR/dist"
  local template_dir="$ROOT_DIR/config/extension"
  local bundles_dir="$dist_root/bundled"

  info "Running esbuild ..."
  (cd "$ROOT_DIR" && node scripts/build-bundles.js --target all) || {
    warn "esbuild failed.  Check for Node.js / npm issues."
    return
  }

  copy_extension_target() {
    local name="$1" manifest_template="$2"
    local target_dir="$dist_root/$name"

    rm -rf "$target_dir"
    mkdir -p "$target_dir"

    # Copy source tree
    cp -r "$ROOT_DIR/src" "$target_dir/src"

    # Overlay esbuild bundles
    if [[ -d "$bundles_dir/src" ]]; then
      cp -r "$bundles_dir/src/"* "$target_dir/src/"
    fi

    # Copy native-host assets if bundled
    if [[ -d "$bundles_dir/native-host" ]]; then
      mkdir -p "$target_dir/native-host"
      cp -r "$bundles_dir/native-host/"* "$target_dir/native-host/"
      info "  Copied native-host assets to $name"
    fi

    # Copy manifest
    cp "$template_dir/$manifest_template" "$target_dir/manifest.json"
    ok "Built $name extension"
  }

  local targets
  if [[ $# -gt 0 ]]; then
    targets=("$@")
  else
    targets=("chromium" "firefox" "yandex")
  fi

  for t in "${targets[@]}"; do
    case "$t" in
      firefox) copy_extension_target "firefox" "manifest.firefox.json" ;;
      yandex)  copy_extension_target "yandex" "manifest.chromium.json" ;;
      *)       copy_extension_target "chromium" "manifest.chromium.json" ;;
    esac
  done

  ok "Extension target(s) built: ${targets[*]}"
}

# ---------------------------------------------------------------------------
# 11.  Register native messaging hosts
# ---------------------------------------------------------------------------
register_native_hosts() {
  header "Native messaging host registration"

  ensure_dir "$NATIVE_DIR"

  # Write manifest JSONs — use PowerShell on Windows, Python elsewhere
  if is_windows; then
    local win_launcher
    win_launcher="$(to_win_path "$HOST_LAUNCHER")"
    local win_native_dir
    win_native_dir="$(to_win_path "$NATIVE_DIR")"
    local win_chrome_manifest
    win_chrome_manifest="$(to_win_path "$CHROME_MANIFEST")"
    local win_yandex_manifest
    win_yandex_manifest="$(to_win_path "$YANDEX_MANIFEST")"
    local win_firefox_manifest
    win_firefox_manifest="$(to_win_path "$FIREFOX_MANIFEST")"

    powershell -NoProfile -Command "
\$ErrorActionPreference = 'Stop'
\$chromePath = '$win_chrome_manifest'
\$yandexPath = '$win_yandex_manifest'
\$firefoxPath = '$win_firefox_manifest'
\$launcher = '$win_launcher'
\$hostName = '$HOST_NAME'
\$chromeId = '$CHROME_EXTENSION_ID'
\$firefoxId = '$FIREFOX_EXTENSION_ID'

\$chrome = [ordered]@{
  name            = \$hostName
  description     = 'Qwin Video Downloader native host'
  path            = \$launcher
  type            = 'stdio'
  allowed_origins = @('chrome-extension://' + \$chromeId + '/')
}
\$firefox = [ordered]@{
  name               = \$hostName
  description        = 'Qwin Video Downloader native host'
  path               = \$launcher
  type               = 'stdio'
  allowed_extensions = @(\$firefoxId)
}
\$utf8 = New-Object System.Text.UTF8Encoding \$false
[System.IO.File]::WriteAllText(\$chromePath, (\$chrome | ConvertTo-Json -Depth 5), \$utf8)
[System.IO.File]::WriteAllText(\$yandexPath, (\$chrome | ConvertTo-Json -Depth 5), \$utf8)
[System.IO.File]::WriteAllText(\$firefoxPath, (\$firefox | ConvertTo-Json -Depth 5), \$utf8)
Write-Output 'Manifest files written'
" 2>&1 || {
      warn "Could not write native messaging manifest files."
      return
    }
  else
    py_inline "
import json, os

host_name = '$HOST_NAME'
chrome_id = '$CHROME_EXTENSION_ID'
firefox_id = '$FIREFOX_EXTENSION_ID'
launcher = '$HOST_LAUNCHER'
native_dir = '$NATIVE_DIR'

chrome = {
    'name': host_name,
    'description': 'Qwin Video Downloader native host',
    'path': launcher,
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://' + chrome_id + '/']
}
firefox = {
    'name': host_name,
    'description': 'Qwin Video Downloader native host',
    'path': launcher,
    'type': 'stdio',
    'allowed_extensions': [firefox_id]
}

for fname, data in [('$HOST_NAME.chrome.json', chrome), ('$HOST_NAME.yandex.json', chrome), ('$HOST_NAME.firefox.json', firefox)]:
    os.makedirs(native_dir, exist_ok=True)
    with open(os.path.join(native_dir, fname), 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
print('Manifest files written')
" || {
      warn "Could not write native messaging manifest files."
      return
    }
  fi
  ok "Manifest files written"

  # Register in Windows Registry (only on Windows)
  if is_windows; then
    local win_manifest
    win_manifest="$(to_win_path "$CHROME_MANIFEST")"
    local win_manifest_yandex
    win_manifest_yandex="$(to_win_path "$YANDEX_MANIFEST")"
    local win_manifest_firefox
    win_manifest_firefox="$(to_win_path "$FIREFOX_MANIFEST")"

    # MSYS2_ARG_CONV_EXCL prevents Git Bash/MSYS2 from mangling backslash
    # paths when passing arguments to Windows executables.
    reg_add() {
      MSYS2_ARG_CONV_EXCL='*' reg.exe add "$1" /ve /t REG_SZ /d "$2" /f &>/dev/null
    }

    local any_registered=false

    if reg_add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\$HOST_NAME" "$win_manifest"; then
      any_registered=true
    else
      warn "Could not register Chrome native messaging host."
    fi

    if reg_add "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\$HOST_NAME" "$win_manifest"; then
      any_registered=true
    else
      warn "Could not register Edge native messaging host."
    fi

    if reg_add "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\$HOST_NAME" "$win_manifest"; then
      any_registered=true
    else
      warn "Could not register Brave native messaging host."
    fi

    if reg_add "HKCU\\Software\\Chromium\\NativeMessagingHosts\\$HOST_NAME" "$win_manifest_yandex"; then
      any_registered=true
    else
      warn "Could not register Chromium native messaging host."
    fi

    if reg_add "HKCU\\Software\\Yandex\\YandexBrowser\\NativeMessagingHosts\\$HOST_NAME" "$win_manifest_yandex"; then
      any_registered=true
    else
      warn "Could not register Yandex native messaging host."
    fi

    if reg_add "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\$HOST_NAME" "$win_manifest_firefox"; then
      any_registered=true
    else
      warn "Could not register Firefox native messaging host."
    fi

    if $any_registered; then
      ok "Native host registered for one or more browsers"
    else
      warn "No browsers were registered. Install Chrome/Firefox/Edge/Brave/Yandex and re-run."
    fi
  else
    info "Skipping Windows Registry registration (non-Windows OS)."
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

  # --- main flow ---
  detect_python
  install_python_packages
  verify_curl_cffi
  install_ffmpeg
  install_gopeed
  install_aria2
  install_stream_fallbacks
  install_you_get_lux
  install_capture_binary
  install_cdm
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
  echo "  Firefox extension ID expected: $FIREFOX_EXTENSION_ID"
  echo ""
  echo "  Tools installed in: $TOOLS_DIR"
  echo "${_BOLD}${_GREEN}══════════════════════════════════════════════════════════════${_RESET}"
  echo ""
}

main "$@"
