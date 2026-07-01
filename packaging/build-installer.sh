#!/usr/bin/env bash
# ============================================================================
# Qwin Video Downloader — Build Self-Contained Windows Installer (Shell)
# ============================================================================
# This is the shell equivalent of build-installer.ps1 for use in Git Bash,
# MSYS2, WSL, or CI environments. On Windows, prefer the PowerShell version.
#
# Usage:
#   bash packaging/build-installer.sh
#   bash packaging/build-installer.sh --skip-pyinstaller --skip-go
# ============================================================================

set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────
if [[ -t 1 ]] && command -v tput &>/dev/null && tput setaf 1 &>/dev/null; then
  _RED=$(tput setaf 1) _GREEN=$(tput setaf 2)
  _YELLOW=$(tput setaf 3) _BLUE=$(tput setaf 4)
  _BOLD=$(tput bold) _RESET=$(tput sgr0)
else
  _RED= _GREEN= _YELLOW= _BLUE= _BOLD= _RESET=
fi

info()  { printf "${_BLUE}%s${_RESET}\\n" "$*"; }
ok()    { printf "${_GREEN}✓ %s${_RESET}\\n" "$*"; }
warn()  { printf "${_YELLOW}⚠ %s${_RESET}\\n" "$*"; }
error() { printf "${_RED}✗ %s${_RESET}\\n" "$*"; }
die()   { error "$1"; exit "${2:-1}"; }
header(){ echo ""; printf "${_BOLD}${_BLUE}━━━ %s ━━━${_RESET}\\n" "$*"; echo ""; }

# ── Parse args ─────────────────────────────────────────────────────────────
SKIP_PYINSTALLER=false
SKIP_GO=false
SKIP_TOOLS=false
SKIP_CRX=false
PEM_KEY=""
PYTHON_CMD="python"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pyinstaller) SKIP_PYINSTALLER=true; shift ;;
    --skip-go)          SKIP_GO=true; shift ;;
    --skip-tools)       SKIP_TOOLS=true; shift ;;
    --skip-crx)         SKIP_CRX=true; shift ;;
    --pem-key)          PEM_KEY="$2"; shift 2 ;;
    --python)           PYTHON_CMD="$2"; shift 2 ;;
    --help|-h)          echo "Usage: $0 [--skip-pyinstaller] [--skip-go] [--skip-tools] [--skip-crx] [--pem-key path] [--python cmd]"; exit 0 ;;
    *)                  die "Unknown option: $1" ;;
  esac
done

# ── Resolve paths ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
STAGING_DIR="$SCRIPT_DIR/installer-source"

# ── Version ─────────────────────────────────────────────────────────────────
if command -v python &>/dev/null; then
  APP_VERSION=$(python -c "import json; print(json.load(open('$ROOT_DIR/manifest.json'))['version'])" 2>/dev/null || echo "1.0.0")
else
  APP_VERSION="1.0.0"
fi
info "Qwin Video Downloader v$APP_VERSION — Build Installer"

# ── Check prerequisites ─────────────────────────────────────────────────────
MISSING=()
command -v node &>/dev/null || MISSING+=("node")
command -v go &>/dev/null   || MISSING+=("go")
command -v "$PYTHON_CMD" &>/dev/null || MISSING+=("python ($PYTHON_CMD)")
command -v ISCC.exe &>/dev/null || MISSING+=("ISCC.exe (Inno Setup)")
command -v curl &>/dev/null || MISSING+=("curl")

if [[ ${#MISSING[@]} -gt 0 ]]; then
  die "Missing prerequisites: ${MISSING[*]}"
fi
ok "All prerequisites found"

# ── Prepare staging directories ─────────────────────────────────────────────
STAGING_SUBDIRS=(
  "extension" "native-host"
  "tools/aria2" "tools/n_m3u8dl-re" "tools/capture" "tools/cdm" "tools/lux"
  "native-manifests"
)

for d in "${STAGING_SUBDIRS[@]}"; do
  mkdir -p "$STAGING_DIR/$d"
done

# ============================================================================
# Step 1: Build JS bundles (esbuild)
# ============================================================================
header "Step 1/8: Build JS bundles"
(cd "$ROOT_DIR" && node scripts/build-bundles.js --target all) || die "esbuild failed"
ok "JS bundles built"

# ============================================================================
# Step 2: Build extension targets
# ============================================================================
header "Step 2/8: Build extension targets"
# The bash install.sh has a build_extension function we can call
# But we should use the same logic directly
(cd "$ROOT_DIR" && node scripts/build-bundles.js --target all)  # already done above

# Manually build extension targets (same logic as scripts/build-extension.ps1)
copy_extension_target() {
  local name="$1" manifest_template="$2"
  local target_dir="$DIST_DIR/$name"
  local bundles_dir="$DIST_DIR/bundled"

  rm -rf "$target_dir"
  mkdir -p "$target_dir"

  cp -r "$ROOT_DIR/src" "$target_dir/src"

  if [[ -d "$bundles_dir/src" ]]; then
    cp -r "$bundles_dir/src/"* "$target_dir/src/"
  fi

  if [[ -d "$bundles_dir/native-host" ]]; then
    mkdir -p "$target_dir/native-host"
    cp -r "$bundles_dir/native-host/"* "$target_dir/native-host/"
  fi

  cp "$ROOT_DIR/config/extension/$manifest_template" "$target_dir/manifest.json"
  ok "Built $name extension"
}

copy_extension_target "chromium" "manifest.chromium.json"
copy_extension_target "firefox" "manifest.firefox.json"
copy_extension_target "yandex" "manifest.chromium.json"

# ============================================================================
# Step 3: Package .crx
# ============================================================================
header "Step 3/8: Package .crx extension"

if [[ "$SKIP_CRX" == "false" && -n "$PEM_KEY" && -f "$PEM_KEY" ]]; then
  if command -v chrome.exe &>/dev/null; then
    chrome.exe --pack-extension="$DIST_DIR/chromium" --pack-extension-key="$PEM_KEY"
    packed_crx="$DIST_DIR/chromium.crx"
    if [[ -f "$packed_crx" ]]; then
      mv "$packed_crx" "$STAGING_DIR/extension/qwin-video-downloader.crx"
      ok ".crx signed and packaged"
    else
      warn "Chrome packing did not produce .crx"
      SKIP_CRX=true
    fi
  else
    warn "Chrome not found, cannot pack .crx"
    SKIP_CRX=true
  fi
else
  SKIP_CRX=true
fi

if [[ "$SKIP_CRX" == "true" ]]; then
  warn "Skipping .crx signing. Staging unpacked extension instead."
  rm -rf "$STAGING_DIR/extension/chromium"
  cp -r "$DIST_DIR/chromium" "$STAGING_DIR/extension/chromium"
  ok "Unpacked extension staged"
fi

# Also stage Firefox
rm -rf "$STAGING_DIR/extension/firefox"
[[ -d "$DIST_DIR/firefox" ]] && cp -r "$DIST_DIR/firefox" "$STAGING_DIR/extension/firefox"

# ============================================================================
# Step 4: Build Go companion binary
# ============================================================================
header "Step 4/8: Build Go companion binary"

if [[ "$SKIP_GO" == "false" ]]; then
  GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$STAGING_DIR/tools/capture/qwin-capture.exe" "$ROOT_DIR/go/"
  if [[ -f "$STAGING_DIR/tools/capture/qwin-capture.exe" ]]; then
    go_size=$(du -h "$STAGING_DIR/tools/capture/qwin-capture.exe" | cut -f1)
    ok "qwin-capture.exe built ($go_size)"
  else
    warn "Go build failed."
  fi
else
  warn "Skipping Go build"
fi

# ============================================================================
# Step 5: Build PyInstaller native host
# ============================================================================
header "Step 5/8: Build PyInstaller native host"

if [[ "$SKIP_PYINSTALLER" == "false" ]]; then
  spec_path="$SCRIPT_DIR/pyinstaller.spec"
  (cd "$ROOT_DIR" && "$PYTHON_CMD" -m PyInstaller "$spec_path" --distpath "$STAGING_DIR/native-host" --workpath "$ROOT_DIR/build/pyinstaller")
  if [[ -f "$STAGING_DIR/native-host/qwin-host.exe" ]]; then
    pyi_size=$(du -h "$STAGING_DIR/native-host/qwin-host.exe" | cut -f1)
    ok "qwin-host.exe built ($pyi_size)"
  else
    warn "PyInstaller build failed."
  fi
else
  warn "Skipping PyInstaller build"
fi

# ============================================================================
# Step 6: Download external tools
# ============================================================================
header "Step 6/8: Download external tools"

download_github_release() {
  local repo="$1" asset_pattern="$2" output_dir="$3" output_name="$4"
  local api_url="https://api.github.com/repos/$repo/releases/latest"
  local json
  json="$(curl -sfL "$api_url" 2>/dev/null)" || return 1

  local download_url
  download_url=$(printf '%s' "$json" | python -c "
import sys, json, re
data = json.load(sys.stdin)
pat = re.compile('$asset_pattern')
for a in data['assets']:
    if pat.search(a['name']):
        print(a['browser_download_url'])
        break
" 2>/dev/null) || return 1

  [[ -z "$download_url" ]] && return 1

  local temp_dir
  temp_dir="$(mktemp -d /tmp/qwin-tool-XXXXXXXX)"
  local zip_path="$temp_dir/tool.zip"

  info "  Downloading $download_url ..."
  curl -sLf "$download_url" -o "$zip_path" || { rm -rf "$temp_dir"; return 1; }

  # Extract
  if command -v unzip &>/dev/null; then
    unzip -qo "$zip_path" -d "$temp_dir"
  else
    python -c "
import zipfile, os
with zipfile.ZipFile('$zip_path') as z:
    z.extractall('$temp_dir')
" 2>/dev/null || { rm -rf "$temp_dir"; return 1; }
  fi

  local found
  found="$(find "$temp_dir" -type f -name "$output_name" 2>/dev/null | head -1)"
  if [[ -z "$found" ]]; then
    rm -rf "$temp_dir"
    return 1
  fi

  mkdir -p "$output_dir"
  cp "$found" "$output_dir/$output_name"
  chmod +x "$output_dir/$output_name" 2>/dev/null || true
  rm -rf "$temp_dir"
  ok "$output_name downloaded"
  return 0
}

if [[ "$SKIP_TOOLS" == "false" ]]; then
  # aria2c
  if [[ ! -f "$STAGING_DIR/tools/aria2/aria2c.exe" ]]; then
    download_github_release "aria2/aria2" "win-64bit.*\.zip$" "$STAGING_DIR/tools/aria2" "aria2c.exe" || \
      warn "aria2c download failed"
  else
    ok "aria2c.exe already present"
  fi

  # N_m3u8DL-RE
  if [[ ! -f "$STAGING_DIR/tools/n_m3u8dl-re/N_m3u8DL-RE.exe" ]]; then
    download_github_release "nilaoda/N_m3u8DL-RE" "(?i)_win-x64_[^_].*\.zip$" "$STAGING_DIR/tools/n_m3u8dl-re" "N_m3u8DL-RE.exe" || \
      warn "N_m3u8DL-RE download failed"
  else
    ok "N_m3u8DL-RE.exe already present"
  fi

  # lux (build from Go source)
  if [[ ! -f "$STAGING_DIR/tools/lux/lux.exe" ]]; then
    info "  Building lux via go install..."
    gopath="$(go env GOPATH)"
    lux_built="$gopath/bin/lux.exe"
    rm -f "$lux_built" 2>/dev/null || true
    GOOS=windows GOARCH=amd64 go install github.com/iawia002/lux@latest 2>/dev/null && {
      if [[ -f "$lux_built" ]]; then
        cp "$lux_built" "$STAGING_DIR/tools/lux/lux.exe"
        ok "lux.exe built"
      else
        warn "lux binary not found after go install"
      fi
    } || warn "lux build failed"
  else
    ok "lux.exe already present"
  fi
else
  warn "Skipping tool downloads"
fi

# ============================================================================
# Step 7: Stage native messaging manifests
# ============================================================================
header "Step 7/8: Stage native messaging manifests"

HOST_NAME="com.qwin.video_downloader"
CHROME_ID="dbjddokdmkodnkiaccmbjagfalmmmkmi"
FIREFOX_ID="qwin-video-downloader@example.com"
LAUNCHER_PATH="{app}\\native-host\\qwin_video_host.bat"
MANIFESTS_DIR="$STAGING_DIR/native-manifests"

# Write Chrome manifest
python -c "
import json
manifest = {
    'name': '$HOST_NAME',
    'description': 'Qwin Video Downloader native host',
    'path': '$LAUNCHER_PATH',
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://$CHROME_ID/']
}
with open('$MANIFESTS_DIR/$HOST_NAME.chrome.json', 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
# Yandex uses the same Chrome manifest
with open('$MANIFESTS_DIR/$HOST_NAME.yandex.json', 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print('Chrome/Yandex manifest written')
"

# Write Firefox manifest
python -c "
import json
manifest = {
    'name': '$HOST_NAME',
    'description': 'Qwin Video Downloader native host',
    'path': '$LAUNCHER_PATH',
    'type': 'stdio',
    'allowed_extensions': ['$FIREFOX_ID']
}
with open('$MANIFESTS_DIR/$HOST_NAME.firefox.json', 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print('Firefox manifest written')
"

ok "Native messaging manifests written"

# ============================================================================
# Step 8: Compile Inno Setup installer
# ============================================================================
header "Compile Inno Setup installer"

(cd "$SCRIPT_DIR" && ISCC.exe "/dMyAppVersion=$APP_VERSION" "qwin-installer.iss") || \
  die "Inno Setup compilation failed"

# ============================================================================
# Output
# ============================================================================
FINAL_INSTALLER="$DIST_DIR/Qwin-Video-Downloader-v$APP_VERSION-Setup.exe"

if [[ -f "$FINAL_INSTALLER" ]]; then
  size_mb=$(du -h "$FINAL_INSTALLER" | cut -f1)
  echo ""
  echo "${_BOLD}${_GREEN}══════════════════════════════════════════════════════════════${_RESET}"
  echo "${_GREEN}  Installer built successfully!${_RESET}"
  echo ""
  echo "  Path:    $FINAL_INSTALLER"
  echo "  Size:    $size_mb"
  echo "  Version: $APP_VERSION"
  echo "${_BOLD}${_GREEN}══════════════════════════════════════════════════════════════${_RESET}"
else
  die "Installer was not created at: $FINAL_INSTALLER"
fi
