"""Individual backend probe functions for parallel reachability checks.

Extracted from probe_runner.py for modularity. Each probe function
checks whether a specific download backend can handle a given URL.
"""

import json
import subprocess
import threading
from typing import Optional

# ── Individual probe functions ─────────────────────────────────────────────

# Each returns a dict:
#   {
#       "ok": bool,
#       "backend": str,
#       "label": str,
#       "error_type": str | None,   # None on success
#       "message": str | None,
#       "status_code": int | None,
#       "raw_output": str | None,
#       "duration_ms": int,
#   }


def _is_cloudflare_403(stderr: str, stdout: str) -> bool:
    """Check if process output indicates a Cloudflare 403 block."""
    combined = (stderr + " " + stdout).lower()
    has_403 = "403" in combined or "http error 403" in combined or "forbidden" in combined
    if not has_403:
        return False
    # Check for Cloudflare-specific patterns in stderr/stdout
    cloudflare_hints = ["cloudflare", "cf-", "challenge-platform"]
    return any(hint in combined for hint in cloudflare_hints)


def _is_cloudflare_response_body(raw_output: str) -> bool:
    """Check if response body (raw_output) is a Cloudflare challenge page.

    Detects multiple generations of Cloudflare challenges:
    - Classic: "Attention Required! | Cloudflare"
    - Turnstile widget (data-turnstile attribute)
    - Generic "Just a moment..." pages with Cloudflare indicators
    - Challenge platform scripts
    """
    if not raw_output or len(raw_output) < 100:
        return False
    text = raw_output[:2000].lower()
    # Classic Cloudflare challenge
    if "cloudflare" in text and "attention required" in text:
        return True
    # Challenge platform scripts
    if "cf-chl" in text or "challenge-platform" in text or "cf-turnstile" in text:
        return True
    # Turnstile widget (data-turnstile attribute)
    if "data-turnstile" in text and ("challenge" in text or "verify" in text):
        return True
    # Generic "Just a moment..." pages protected by Cloudflare
    if "just a moment" in text and ("cloudflare" in text or "cf-ray" in text):
        return True
    return False


def _is_token_expired(stderr: str, stdout: str) -> bool:
    """Check if process output indicates a token/signature expiry error.

    Detects:
    - Signed URLs with "expired" keyword (410 Gone, 403 Forbidden)
    - URL contains "expires" parameter and returned 403
    - Signature/key mismatch or expired errors
    - AWS CloudFront signed URL expiry
    - Generic "has expired" error messages (no HTTP code required)

    Args:
        stderr: Stderr output from the process.
        stdout: Stdout output from the process.

    Returns:
        True if the output indicates a token/signature expiry error.
    """
    combined = (stderr + " " + stdout).lower()

    # Check for explicit "expired" keyword with HTTP error codes
    if "expired" in combined and any(code in combined for code in ["410", "403"]):
        return True

    # Check for signature/key errors
    if "signature" in combined and ("expired" in combined or "mismatch" in combined):
        return True

    # Check for CloudFront signed URL errors
    if "cloudfront" in combined and "expired" in combined:
        return True

    # Check for "expires" in the URL (signed URL pattern) with access denied
    if "/expires=" in combined.lower() or "?expires=" in combined.lower():
        if any(code in combined for code in ["403", "401"]):
            return True

    # Generic "has expired" in error messages — catches cases like
    # "This video URL has expired" without a specific HTTP status code.
    # Runs after Cloudflare/status-code checks so won't false-positive
    # on blocked-but-expired messages (those are caught above).
    if "has expired" in combined:
        return True

    return False


def probe_yt_dlp(
    url: str,
    cancel_event: threading.Event,
    yt_dlp_command: list[str],
    ffmpeg_location: Optional[str] = None,
) -> dict:
    """Run yt-dlp --skip-download --dump-single-json. Success if exit 0 + non-empty formats."""
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    command = [
        *yt_dlp_command,
        "--skip-download",
        "--dump-single-json",
        "--no-config",
        "--no-cache-dir",
        "--no-warnings",
        "--ignore-errors",
        "--socket-timeout",
        "15",
        str(url),
    ]

    if ffmpeg_location:
        command.extend(["--ffmpeg-location", str(ffmpeg_location)])

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "timeout",
            "message": "yt-dlp probe timed out after 30 seconds",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 30000,
        }

    if completed.returncode != 0:
        stderr_text = (completed.stderr or "").strip()
        stdout_text = (completed.stdout or "").strip()
        combined = stderr_text or stdout_text

        # Check for Cloudflare-specific 403 in error output
        if _is_cloudflare_403(stderr_text, stdout_text):
            return {
                "ok": False,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": "cloudflare_block",
                "message": "yt-dlp blocked by Cloudflare anti-bot protection (HTTP 403)",
                "status_code": 403,
                "raw_output": combined,
                "duration_ms": 0,
            }

        # Check for token/signature expiry before generic exit_code
        if _is_token_expired(stderr_text, stdout_text):
            return {
                "ok": False,
                "backend": "yt-dlp",
                "label": "yt-dlp (skip-download)",
                "error_type": "token_expired",
                "message": "yt-dlp detected token or signature expiry",
                "status_code": completed.returncode,
                "raw_output": combined,
                "duration_ms": 0,
            }

        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "exit_code",
            "message": f"yt-dlp exited with code {completed.returncode}",
            "status_code": completed.returncode,
            "raw_output": combined,
            "duration_ms": 0,
        }

    # Parse JSON output
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "parse_error",
            "message": "Failed to parse yt-dlp JSON output",
            "status_code": None,
            "raw_output": completed.stdout[:2000] if completed.stdout else "",
            "duration_ms": 0,
        }

    formats = data.get("formats") or []
    if len(formats) == 0:
        return {
            "ok": False,
            "backend": "yt-dlp",
            "label": "yt-dlp (skip-download)",
            "error_type": "no_formats",
            "message": "yt-dlp returned no formats for this URL",
            "status_code": None,
            "raw_output": completed.stdout[:2000] if completed.stdout else "",
            "duration_ms": 0,
        }

    return {
        "ok": True,
        "backend": "yt-dlp",
        "label": "yt-dlp (skip-download)",
        "error_type": None,
        "message": None,
        "status_code": None,
        "raw_output": None,
        "duration_ms": 0,
    }


def probe_curl_cffi(
    url: str,
    cancel_event: threading.Event,
    headers: Optional[dict] = None,
    chrome_version: Optional[str] = None,
    chrome_versions: Optional[list[str]] = None,
) -> dict:
    """HTTP HEAD request with TLS impersonation. Success if 2xx/3xx response.

    Parameters
    ----------
    chrome_version : str, optional
        Specific Chrome version to impersonate (e.g. "131").
        If None, uses the default "chrome" fingerprint.
    chrome_versions : list[str], optional
        Additional Chrome versions to try on 403/block. When the primary
        impersonation gets blocked by Cloudflare, each version from this
        list is tried in sequence before giving up.
    """
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "curl_cffi",
            "label": "curl-cffi (HEAD)",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    def _try_impersonate(cv):
        """Make a single HEAD request with a given impersonation version."""
        try:
            from curl_cffi import requests as curl_requests

            impersonate_value = f"chrome{cv}" if cv else "chrome"
            resp = curl_requests.head(
                url,
                headers=dict(headers or {}),
                impersonate=impersonate_value,
                timeout=12,
                verify=True,
            )

            if resp.ok:
                return {
                    "ok": True,
                    "backend": "curl_cffi",
                    "label": "curl-cffi (HEAD)",
                    "error_type": None,
                    "message": None,
                    "status_code": resp.status_code,
                    "raw_output": None,
                    "duration_ms": 0,
                }

            resp_body = resp.text[:2000] if resp.text else ""
            if resp.status_code == 403 and _is_cloudflare_response_body(resp_body):
                return {
                    "ok": False,
                    "backend": "curl_cffi",
                    "label": "curl-cffi (HEAD)",
                    "error_type": "cloudflare_block",
                    "message": (
                        "HTTP 403: Cloudflare anti-bot protection blocked request"
                        f" (impersonation: chrome{cv or 'default'})"
                    ),
                    "status_code": 403,
                    "raw_output": resp_body,
                    "duration_ms": 0,
                }
            return {
                "ok": False,
                "backend": "curl_cffi",
                "label": "curl-cffi (HEAD)",
                "error_type": "http_error",
                "message": f"HTTP {resp.status_code}",
                "status_code": resp.status_code,
                "raw_output": resp_body,
                "duration_ms": 0,
            }
        except ImportError:
            return None
        except Exception as exc:
            return {
                "ok": False,
                "backend": "curl_cffi",
                "label": "curl-cffi (HEAD)",
                "error_type": "request_error",
                "message": str(exc),
                "status_code": None,
                "raw_output": str(exc),
                "duration_ms": 0,
            }

    # ── Try primary impersonation first ───────────────────────────────────
    result = _try_impersonate(chrome_version)
    if result is not None:
        if result["ok"]:
            return result
        # If blocked by Cloudflare AND we have alternate versions, rotate
        if result["error_type"] == "cloudflare_block" and chrome_versions:
            for alt_version in chrome_versions:
                if alt_version == chrome_version:
                    continue
                alt_result = _try_impersonate(alt_version)
                if alt_result is None:
                    continue
                if alt_result["ok"]:
                    return alt_result
                # If this version also gets a non-CF error, stop rotating
                if alt_result["error_type"] != "cloudflare_block":
                    return alt_result
            # All versions got blocked — return the original result
            return result
        return result

    # ── Fallback to urllib ───────────────────────────────────────────────
    try:
        import urllib.error
        import urllib.request

        req = urllib.request.Request(str(url), method="HEAD", headers=dict(headers or {}))
        with urllib.request.urlopen(req, timeout=12) as resp:
            return {
                "ok": True,
                "backend": "curl_cffi",
                "label": "curl-cffi (HEAD)",
                "error_type": None,
                "message": None,
                "status_code": resp.status,
                "raw_output": None,
                "duration_ms": 0,
            }
    except urllib.error.HTTPError as exc:
        return {
            "ok": False,
            "backend": "curl_cffi",
            "label": "curl-cffi (HEAD)",
            "error_type": "http_error",
            "message": f"HTTP {exc.code} {exc.reason}",
            "status_code": exc.code,
            "raw_output": str(exc),
            "duration_ms": 0,
        }
    except Exception as exc:
        return {
            "ok": False,
            "backend": "curl_cffi",
            "label": "curl-cffi (HEAD)",
            "error_type": "request_error",
            "message": str(exc),
            "status_code": None,
            "raw_output": str(exc),
            "duration_ms": 0,
        }


def probe_n_m3u8dl_re(
    url: str,
    cancel_event: threading.Event,
    n_m3u8dl_re_location: str,
) -> dict:
    """Fetch the manifest URL and check if it's parseable (success if exit 0)."""
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "n_m3u8dl_re",
            "label": "N_m3u8DL-RE",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    command = [
        str(n_m3u8dl_re_location),
        "--test",
        str(url),
    ]

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "backend": "n_m3u8dl_re",
            "label": "N_m3u8DL-RE",
            "error_type": "timeout",
            "message": "N_m3u8DL-RE probe timed out",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 30000,
        }

    if completed.returncode != 0:
        return {
            "ok": False,
            "backend": "n_m3u8dl_re",
            "label": "N_m3u8DL-RE",
            "error_type": "exit_code",
            "message": f"N_m3u8DL-RE exited with code {completed.returncode}",
            "status_code": completed.returncode,
            "raw_output": (completed.stderr or "").strip() or (completed.stdout or "").strip(),
            "duration_ms": 0,
        }

    return {
        "ok": True,
        "backend": "n_m3u8dl_re",
        "label": "N_m3u8DL-RE",
        "error_type": None,
        "message": None,
        "status_code": None,
        "raw_output": None,
        "duration_ms": 0,
    }


def probe_streamlink(
    url: str,
    cancel_event: threading.Event,
    streamlink_command: list[str],
) -> dict:
    """Run streamlink --json URL to check stream availability."""
    if cancel_event.is_set():
        return {
            "ok": False,
            "backend": "streamlink",
            "label": "Streamlink",
            "error_type": "cancelled",
            "message": "Cancelled before start",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 0,
        }

    command = [
        *streamlink_command,
        "--json",
        "--no-config",
        str(url),
    ]

    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "backend": "streamlink",
            "label": "Streamlink",
            "error_type": "timeout",
            "message": "Streamlink probe timed out",
            "status_code": None,
            "raw_output": None,
            "duration_ms": 30000,
        }

    if completed.returncode != 0:
        return {
            "ok": False,
            "backend": "streamlink",
            "label": "Streamlink",
            "error_type": "exit_code",
            "message": f"Streamlink exited with code {completed.returncode}",
            "status_code": completed.returncode,
            "raw_output": (completed.stderr or "").strip() or (completed.stdout or "").strip(),
            "duration_ms": 0,
        }

    # Check for non-empty stream list
    try:
        data = json.loads(completed.stdout) if completed.stdout.strip() else {}
        streams = data.get("streams") if isinstance(data, dict) else {}
        if not streams:
            return {
                "ok": False,
                "backend": "streamlink",
                "label": "Streamlink",
                "error_type": "no_streams",
                "message": "Streamlink returned no available streams",
                "status_code": None,
                "raw_output": completed.stdout[:2000] if completed.stdout else "",
                "duration_ms": 0,
            }
    except json.JSONDecodeError:
        pass

    return {
        "ok": True,
        "backend": "streamlink",
        "label": "Streamlink",
        "error_type": None,
        "message": None,
        "status_code": None,
        "raw_output": None,
        "duration_ms": 0,
    }


# ── Helper ─────────────────────────────────────────────────────────────────


def curl_cffi_available():
    """Check whether curl_cffi is importable."""
    try:
        import curl_cffi  # noqa: F401

        return True
    except ImportError:
        return False
