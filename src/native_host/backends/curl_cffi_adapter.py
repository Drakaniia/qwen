"""curl_cffi adapter — TLS-impersonated HTTP client for bypassing WAF/CDN blocking.

Provides browser-matching TLS/HTTP2 fingerprints via the ``curl_cffi`` library,
which ships as part of ``yt-dlp[default,curl-cffi]``.

Every public function falls back gracefully to urllib when curl_cffi is not
installed, so the rest of the host keeps working without it.
"""

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from threading import Event

# ── Path bootstrap (subprocess-safe) ──────────────────────────────────────
# When this script is launched as a subprocess by download_manager.py, Python
# only puts the script's own directory (backends/) on sys.path.  We need the
# rest of the native_host tree (system/, download/, fallback_engines/, …) too.
# Mirroring host.py's walk ensures imports work identically in both contexts.
_native_host_dir = Path(__file__).resolve().parent.parent  # …/src/native_host
for _root, _dirs, _files in _native_host_dir.walk():
    _dirs[:] = [d for d in _dirs if d != "__pycache__" and not d.startswith("_")]
    _p = str(_root)
    if _p not in sys.path:
        sys.path.insert(0, _p)
# ──────────────────────────────────────────────────────────────────────────

from fallback_engines import download_direct as _download_direct_fallback

from native_protocol import HostError

# ── Detection ──────────────────────────────────────────────────────────────


def curl_cffi_available():
    """Check whether ``curl_cffi`` is importable."""
    try:
        import curl_cffi  # noqa: F401

        return True
    except ImportError:
        return False


# ── Fetch (page text) ──────────────────────────────────────────────────────


def fetch_page_text(url, headers, impersonate="chrome"):
    """Fetch a page's text content using curl_cffi with TLS impersonation.

    Falls back to ``urllib.request.urlopen()`` if curl_cffi is unavailable.

    Parameters
    ----------
    url : str
        The URL to fetch.
    headers : dict
        HTTP headers to send (User-Agent, Referer, Cookie, etc.).
    impersonate : str
        Browser version to impersonate (default ``"chrome"``).

    Returns
    -------
    str
        The response body decoded as UTF-8 (with replacement for invalid
        byte sequences), or ``""`` on failure.
    """
    if not curl_cffi_available():
        return _fetch_page_text_fallback(url, headers)

    try:
        from curl_cffi import requests as curl_requests

        resp = curl_requests.get(url, headers=dict(headers or {}), impersonate=impersonate, timeout=12, verify=True)
        resp.raise_for_status()
        content = resp.content
        if isinstance(content, bytes):
            return content.decode("utf-8", errors="replace")
        return str(content)
    except Exception:
        return _fetch_page_text_fallback(url, headers)


def _fetch_page_text_fallback(url, headers):
    """Fallback fetch using plain urllib."""
    try:
        req = urllib.request.Request(url, headers=dict(headers or {}))
        with urllib.request.urlopen(req, timeout=12) as resp:
            content = resp.read(1_500_000)
            return content.decode("utf-8", errors="replace")
    except Exception:
        return ""


# ── Download (in-process) ──────────────────────────────────────────────────


def download_with_curl_cffi(
    url,
    output_path,
    headers,
    cancel_event=None,
    progress_callback=None,
    chunk_size=8192,
    impersonate="chrome",
):
    """Stream a media URL to disk using curl_cffi with TLS impersonation.

    Falls back to :func:`_download_direct_fallback` (urllib) if curl_cffi
    is unavailable.

    Parameters
    ----------
    url : str
        Direct media URL to download.
    output_path : str or Path
        Destination file path.
    headers : dict
        HTTP headers (Referer, User-Agent, Cookie, etc.).
    cancel_event : threading.Event or None
        When set, the download is aborted and the partial file is removed.
    progress_callback : callable or None
        Called as ``progress_callback(bytes_downloaded, total_bytes)``.
    chunk_size : int
        Read chunk size in bytes (default 8 KB).
    impersonate : str
        Browser version to impersonate (default ``"chrome"``, can be
        version-specific like ``"chrome131"``).

    Returns
    -------
    str or None
        ``output_path`` on success, ``None`` on cancellation.

    Raises
    ------
    HostError
        On download failure (HTTP error, network error, etc.).
    """
    if not curl_cffi_available():
        return _download_direct_fallback(url, output_path, cancel_event, progress_callback, chunk_size)

    cancel = cancel_event or Event()
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Check for cancellation before making the network request
    if cancel.is_set():
        return None

    try:
        from curl_cffi import requests as curl_requests

        # curl_cffi Response does not support context manager protocol;
        # the response is used directly and cleaned up in the except/finally.
        resp = curl_requests.get(
            url,
            headers=dict(headers or {}),
            stream=True,
            impersonate=impersonate,
            timeout=30,
            verify=True,
        )
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        downloaded = 0
        try:
            with open(str(output), "wb") as f:
                for chunk in resp.iter_content(chunk_size=chunk_size):
                    if cancel.is_set():
                        f.close()
                        if output.exists():
                            output.unlink()
                        return None
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        if progress_callback:
                            progress_callback(downloaded, total)
        finally:
            resp.close()
        return str(output)
    except Exception as exc:
        # Clean up partial file on error
        if output.exists():
            output.unlink()
        raise HostError(f"curl-cffi download failed: {exc}") from exc


# _download_direct_fallback is imported from fallback_engines


# ── Download (subprocess CLI command) ──────────────────────────────────────


def download_curl_cffi_command(url, output_path, headers, impersonate="chrome"):
    """Build a subprocess command that downloads a URL via curl_cffi.

    The returned tuple can be unpacked as ``command, temp_files`` where
    *command* is a list of strings suitable for ``subprocess.Popen`` and
    *temp_files* is a list of temporary file paths the caller should clean
    up after the subprocess completes::

        cmd, tmp = download_curl_cffi_command(...)
        task = DownloadTask(..., command=cmd, temp_files=tmp)

    Unlike the old behaviour (inline ``-c`` script), this implementation
    writes headers to a temporary JSON file and invokes the module's own
    ``__main__`` CLI via ``python curl_cffi_adapter.py --header-file ...``.
    This avoids the Windows ``CreateProcess`` 32 KiB command-line limit
    (WinError 206) when the browser sends hundreds of cookie/header entries.

    The subprocess writes the response body to *output_path* and exits with
    code 0 on success or 1 on failure.

    Parameters
    ----------
    url : str
        Direct media URL to download.
    output_path : str or Path
        Destination file path.
    headers : dict
        HTTP headers to include in the request.
    impersonate : str
        Browser version to impersonate (default ``"chrome"``, can be
        version-specific like ``"chrome131"``).

    Returns
    -------
    tuple[list[str], list[str]]
        ``(command, temp_files)`` — subprocess command and list of paths
        to clean up after execution.
    """
    # Write headers to a temporary JSON file to avoid Windows command-line
    # length limits (WinError 206). The caller is responsible for cleanup.
    hdrs_fd, hdrs_path = tempfile.mkstemp(
        suffix=".json", prefix="qwin-curl-hdrs-", text=True
    )
    with os.fdopen(hdrs_fd, "w", encoding="utf-8") as f:
        json.dump(dict(headers or {}), f)

    adapter_path = str(Path(__file__).resolve())
    command = [
        sys.executable,
        adapter_path,
        url,
        "--output",
        str(output_path),
        "--header-file",
        hdrs_path,
        "--impersonate",
        impersonate,
    ]
    return command, [hdrs_path]


# ── CLI entry point (for subprocess invocation) ────────────────────────────

if __name__ == "__main__":
    """CLI wrapper: python curl_cffi_adapter.py <url> --output <path> [--header K:V ...] [--header-file <json>] [--impersonate <str>]."""
    import argparse

    parser = argparse.ArgumentParser(description="Download a media URL with curl_cffi TLS impersonation.")
    parser.add_argument("url", help="Direct media URL to download")
    parser.add_argument("--output", "-o", required=True, help="Output file path")
    parser.add_argument("--header", "-H", action="append", default=[], help="HTTP header (Key: Value)")
    parser.add_argument("--header-file", "--hf", help="JSON file containing HTTP headers dict")
    parser.add_argument("--impersonate", default="chrome", help="Browser version to impersonate (e.g. chrome131)")
    args = parser.parse_args()

    headers = {}
    for h in args.header:
        if ":" in h:
            key, val = h.split(":", 1)
            headers[key.strip()] = val.strip()

    if args.header_file:
        with open(args.header_file, "r", encoding="utf-8") as _f:
            _from_file = json.load(_f)
        if isinstance(_from_file, dict):
            # File headers take precedence over inline --header args
            headers.update(_from_file)

    try:
        result = download_with_curl_cffi(args.url, args.output, headers, impersonate=args.impersonate)
        sys.exit(0 if result else 1)
    except HostError:
        sys.exit(1)
    except Exception:
        sys.exit(1)
