import re

# Re-exported so importers of the pre-split path keep working; the reader now
# lives in its own module (spec D13).
from output_reader import iter_process_output_lines  # noqa: F401

FILEPATH_MARKER = "__QWIN_FILEPATH__:"


def latest_output_line(line):
    cleaned = str(line).rstrip("\r\n")
    parts = [part.strip() for part in re.split(r"[\r\n]+", cleaned) if part.strip()]
    return parts[-1] if parts else cleaned


def compact_progress_value(value):
    return re.sub(r"\s+", "", str(value or "").strip().lstrip("~").strip())


def parse_yt_dlp_line(line):
    """Back-compat entry point: dispatch `line` to the parser package.

    The per-backend parsers live in `download/parsers/` (spec D11) and need this
    module's shared helpers, so the import is deferred to call time to keep the
    dependency one-way.
    """
    from parsers import parse_line

    return parse_line(line)


# Cloudflare challenge page detection


def is_cloudflare_challenge(content: bytes) -> bool:
    """Check if downloaded content is a Cloudflare challenge page.

    When Cloudflare blocks a request, it returns an HTML challenge page
    instead of the actual video content. This helps detect corrupted
    downloads that "succeeded" but contained HTML instead of video.

    Detects multiple generation of Cloudflare challenges:
    - Classic: "Attention Required! | Cloudflare"
    - Turnstile widgets (cf-turnstile, turnstile)
    - Generic "Just a moment..." pages
    - "Checking your browser before accessing"
    - DDoS protection pages
    - Unusual traffic detection
    - JavaScript challenge (jschl-answer scripts)
    - Generic anti-bot pages (heuristic: HTML start + multiple bot keywords)
    """
    if len(content) < 100:
        return False
    try:
        text = content[:4000].decode("utf-8", errors="ignore").lower()
    except Exception:
        return False

    # ── Quick positive matches ───────────────────────────────────────

    # Classic Cloudflare challenge
    if "cloudflare" in text and "attention required" in text:
        return True
    if "cf-chl" in text or "challenge-platform" in text:
        return True

    # Turnstile / newer challenge patterns
    if "cf-turnstile" in text or "turnstile.force" in text:
        return True

    # js-challenge answer scripts
    if "jschl-answer" in text or "jschl_vc" in text:
        return True

    # ── Generic anti-bot page heuristic ─────────────────────────────
    # Cloudflare and other WAFs serve HTML pages that have no video/media
    # content. These pages typically start with HTML DOCTYPE and contain
    # multiple anti-bot/captcha/challenge keywords.

    if not (text.startswith("<!doctype html") or text.startswith("<html")):
        return False

    # Check for combined anti-bot patterns
    if "unusual traffic" in text and ("challenge" in text or "captcha" in text or "verify" in text):
        return True

    if "just a moment" in text and ("browser" in text or "checking" in text or "verify" in text or "wait" in text):
        return True

    if "checking your browser" in text and ("before accessing" in text or "before proceeding" in text):
        return True

    if "ddos" in text and ("protection" in text or "challenge" in text or "verify" in text):
        return True

    # Generic heuristic: HTML page with multiple anti-bot keywords
    bot_keywords = [
        "cf-",
        "cdn-cgi",
        "challenge-form",
        "challenge-running",
        "enable javascript",
        "your browser",
        "automated access",
        "automated request",
        "suspicious activity",
        "webdriver",
        "selenium",
        "headless",
    ]
    bot_count = sum(1 for kw in bot_keywords if kw in text)
    # Keep track of negative signals: actual video/media references
    video_signals = sum(1 for vs in ["video", "media", "movie", "m3u8", "mp4"] if vs in text)

    if bot_count >= 2 and video_signals == 0:
        return True

    return False
