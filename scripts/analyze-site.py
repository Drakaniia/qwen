#!/usr/bin/env python3
"""
analyze-site.py — Phase 0 site analysis for @e2e-tdd skill.

Uses a real browser (Playwright) to render the page, so you can see the actual
<video> elements, network requests for HLS/DASH streams, and JS variables
that are only available after JavaScript execution.

Usage:
    python scripts/analyze-site.py <url> [--static] [--output json|table]

Options:
    --static     Use HTTP requests only (no browser). Faster but can't see
                 JS-rendered video elements. Useful as a quick check.
    --output     Output format: json or table (default)

Prerequisites:
    pip install playwright
    playwright install chromium

Output:
    JSON with:
    - page_info: title, content_type, status, server
    - dom_video: <video> elements found in rendered DOM
    - dom_iframes: <iframe> elements found in rendered DOM
    - network_streams: .m3u8/.mpd/.mp4 URLs captured from network requests
    - js_vars: player config from window.__NEXT_DATA__, playerConfig, etc.
    - yt_dlp: whether yt-dlp supports the site
    - static: (only with --static) static HTML analysis results
    - verdict: recommended detection path
"""

import json
import platform
import re
import subprocess
import sys
import urllib.parse


# Force UTF-8 for stdout to avoid cp1252 encoding errors
try:
    if sys.stdout.encoding and sys.stdout.encoding.upper() != "UTF-8":
        sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


# ─── Helpers ───────────────────────────────────────────────────────────────


def find_executable(name):
    try:
        if platform.system() == "Windows":
            cmd = ["where", name]
        else:
            cmd = ["which", name]
        return subprocess.call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0
    except Exception:
        return False


# ─── Browser Analysis (Primary) ────────────────────────────────────────────


def analyze_with_browser(url):
    """Load the page in a real browser, execute JS, and extract video info."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {
            "url": url,
            "error": "Playwright not installed. Run: pip install playwright && playwright install chromium",
            "fix": "pip install playwright && playwright install chromium",
        }

    result = {
        "page_info": {"url": url},
        "dom_video": [],
        "dom_iframes": [],
        "network_streams": [],
        "js_vars": {},
        "yt_dlp": None,
        "verdict": "",
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1280, "height": 720},
        )
        page = context.new_page()

        # Track all network requests to find stream URLs
        network_requests = []

        def on_request(request):
            url_lower = request.url.lower()
            # Track stream URLs
            if any(ext in url_lower for ext in [".m3u8", ".mpd", ".mp4", ".webm", ".ts", ".m4s"]):
                network_requests.append({
                    "url": request.url,
                    "type": request.resource_type,
                    "method": request.method,
                })
            # Also track XHR/fetch to API endpoints that might return video URLs
            elif (request.resource_type in ("xhr", "fetch")
                  and any(kw in url_lower for kw in ["video", "stream", "media", "manifest", "playlist", "/api/"])):
                network_requests.append({
                    "url": request.url,
                    "type": request.resource_type + "-api",
                    "method": request.method,
                })

        page.on("request", on_request)

        # Navigate and wait for full JS execution
        try:
            resp = page.goto(url, wait_until="networkidle", timeout=30000)
            if resp:
                result["page_info"]["status"] = resp.status
                result["page_info"]["content_type"] = (
                    resp.headers.get("content-type", "").split(";")[0].strip()
                )
                result["page_info"]["server"] = resp.headers.get("server", "")
                result["page_info"]["cloudflare"] = "cloudflare" in resp.headers.get("server", "").lower()

            # Extra wait for lazy-loaded players (ads, delayed embeds)
            page.wait_for_timeout(5000)

        except Exception as e:
            result["page_info"]["navigation_error"] = str(e)

        result["page_info"]["title"] = page.title()
        result["page_info"]["final_url"] = page.url
        result["page_info"]["url"] = url

        # Extract <video> elements from the RENDERED DOM (this is the key part)
        video_info = page.evaluate("""() => {
            const videos = document.querySelectorAll('video');
            return Array.from(videos).map((v, i) => ({
                index: i,
                src: v.currentSrc || v.src || '',
                width: v.videoWidth || v.clientWidth,
                height: v.videoHeight || v.clientHeight,
                duration: v.duration,
                poster: v.poster || '',
                hasBlobUrl: (v.currentSrc || v.src || '').startsWith('blob:'),
                isVisible: v.clientWidth > 0 && v.clientHeight > 0,
                hasSourceChildren: v.querySelectorAll('source').length > 0,
                sourceTags: Array.from(v.querySelectorAll('source')).map(s => s.src),
                muted: v.muted,
                loop: v.loop,
                autoplay: v.autoplay,
                readyState: v.readyState,
                networkState: v.networkState,
            }));
        }""")
        result["dom_video"] = video_info

        # Extract <iframe> elements
        iframe_info = page.evaluate("""() => {
            const iframes = document.querySelectorAll('iframe');
            return Array.from(iframes).map(f => ({
                src: f.src || '',
                width: f.width,
                height: f.height,
            })).filter(f => f.src && !f.src.includes('google')
                      && !f.src.includes('facebook')
                      && !f.src.includes('doubleclick'));
        }""")
        result["dom_iframes"] = iframe_info

        # Extract JS globals that might contain video config
        js_globals = page.evaluate("""() => {
            const r = {};
            if (window.__NEXT_DATA__) {
                r.__NEXT_DATA__ = true;
                try {
                    const data = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
                    const s = JSON.stringify(data);
                    const urls = [...s.matchAll(/https?:\\/\\/[^\\s"']+\\.(?:m3u8|mpd|mp4|webm)[^\\s"']*/gi)];
                    if (urls.length) r.next_data_streams = urls.map(m => m[0]).slice(0,5);
                } catch(e) {}
            }
            if (window.__INITIAL_STATE__) r.__INITIAL_STATE__ = true;
            if (window.__NUXT__) r.__NUXT__ = true;
            if (window.playerConfig) r.playerConfig = typeof window.playerConfig;
            if (window.videoData) r.videoData = typeof window.videoData;
            if (window.videojs) r.videojs = true;
            if (window.hls) r.hls = true;
            if (window.dashjs) r.dashjs = true;
            if (window.shaka) r.shaka = true;
            if (window.jwplayer) r.jwplayer = true;
            return r;
        }""")
        result["js_vars"] = js_globals

        result["network_streams"] = network_requests

        browser.close()

    # Try yt-dlp
    result["yt_dlp"] = _try_yt_dlp(url)

    # Generate verdict
    result["verdict"] = _generate_browser_verdict(result)

    return result


def _generate_browser_verdict(result):
    """Generate verdict based on browser-rendered results."""
    parts = []
    videos = result.get("dom_video", [])
    iframes = result.get("dom_iframes", [])
    streams = result.get("network_streams", [])
    js = result.get("js_vars", {})
    yt = result.get("yt_dlp")

    # Real <video> elements found in DOM
    real_videos = [v for v in videos if v.get("src") or v.get("sourceTags")]

    if real_videos:
        has_blob = any(v.get("hasBlobUrl") for v in real_videos)
        has_hls = any(".m3u8" in (v.get("src", "") + " ".join(v.get("sourceTags", []))) for v in real_videos)
        has_dash = any(".mpd" in (v.get("src", "") + " ".join(v.get("sourceTags", []))) for v in real_videos)
        if has_hls:
            parts.append("real-video (HLS detected)")
        elif has_dash:
            parts.append("real-video (DASH detected)")
        elif has_blob:
            parts.append("real-video (blob:// MSE player)")
        else:
            parts.append(f"real-video ({len(real_videos)} found)")

    # Network stream URLs
    hls_streams = [s for s in streams if ".m3u8" in s.get("url", "").lower()]
    dash_streams = [s for s in streams if ".mpd" in s.get("url", "").lower()]
    if hls_streams:
        parts.append(f"hls-stream ({len(hls_streams)} found)")
    if dash_streams:
        parts.append(f"dash-stream ({len(dash_streams)} found)")
    direct_mp4 = [s for s in streams if ".mp4" in s.get("url", "").lower() and ".m3u8" not in s.get("url", "").lower()]
    if direct_mp4:
        parts.append(f"mp4-stream ({len(direct_mp4)} found)")

    # API endpoints returning video data
    api_streams = [s for s in streams if "api" in s.get("type", "")]
    if api_streams:
        parts.append(f"video-api ({len(api_streams)} endpoints)")

    # Iframe embeds
    if iframes:
        hosts = [urllib.parse.urlparse(f.get("src", "")).hostname for f in iframes if f.get("src", "").startswith("http")]
        hosts = [h for h in hosts if h]
        if hosts:
            parts.append(f"iframe-embed → {hosts[0]}")

    # JS player SDKs detected
    if js.get("hls"):
        parts.append("hls.js-detected")
    if js.get("shaka"):
        parts.append("shaka-detected")
    if js.get("dashjs"):
        parts.append("dashjs-detected")
    if js.get("jwplayer"):
        parts.append("jwplayer-detected")
    if js.get("videojs"):
        parts.append("videojs-detected")

    # yt-dlp
    if yt and yt.get("supported") is True:
        parts.append(f"yt-dlp ({yt.get('extractor', 'generic')})")
    elif yt and yt.get("supported") is False:
        parts.append("yt-dlp-unsupported")

    if not parts:
        parts.append("no-video-detected")
        if js.get("__NEXT_DATA__"):
            parts.append("next-data-available-yt-dlp-may-work")

    return " → ".join(parts)


# ─── Static Fallback (--static flag) ────────────────────────────────────────


def analyze_static(url):
    """Quick static analysis using HTTP requests. No JS execution."""
    result = {
        "page_info": {"url": url},
        "detection": {},
        "streams": [],
        "iframes": [],
        "js_vars": {},
        "cdn_hints": [],
        "yt_dlp": None,
        "verdict": "",
    }

    # Try curl_cffi first (handles Cloudflare challenges)
    session = None
    try:
        import curl_cffi.requests as curl_req
        session = curl_req.Session()
        session.headers.update({"User-Agent": USER_AGENT, "Accept": "text/html,*/*"})
        session.impersonate = "chrome120"
    except ImportError:
        pass

    if session is None:
        try:
            import requests as req
        except ImportError:
            result["error"] = "requests not installed. Run: pip install requests"
            return result
        session = req.Session()
        session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        })

    try:
        head_resp = session.head(url, timeout=15, allow_redirects=True)
        result["page_info"]["status"] = head_resp.status_code
        result["page_info"]["content_type"] = head_resp.headers.get("Content-Type", "").split(";")[0].strip()
        result["page_info"]["server"] = head_resp.headers.get("Server", "")
        result["page_info"]["cloudflare"] = "cloudflare" in head_resp.headers.get("Server", "").lower()
    except Exception as e:
        result["page_info"]["error"] = str(e)
        result["yt_dlp"] = _try_yt_dlp(url)
        result["verdict"] = f"http-error ({str(e)[:50]})"
        return result

    html = ""
    try:
        resp = session.get(url, timeout=20, allow_redirects=True)
        html = resp.text
        result["page_info"]["title"] = (
            re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
            .group(1).strip()
            if re.search(r"<title[^>]*>(.*?)</title>", html, re.DOTALL | re.IGNORECASE)
            else ""
        )
    except Exception as e:
        result["page_info"]["fetch_error"] = str(e)
        result["yt_dlp"] = _try_yt_dlp(url)
        result["verdict"] = f"fetch-error ({str(e)[:50]})"
        return result

    # Classify
    result["detection"]["classification"] = _classify_page(
        result["page_info"].get("content_type", ""), html, url
    )

    # Video elements from static HTML
    video_srcs = re.findall(r'<video[^>]*src=["\']([^"\']+)["\']', html, re.IGNORECASE)
    result["detection"]["static_video_elements"] = len(video_srcs)

    # Iframes
    iframes = re.findall(r'<iframe[^>]*src=["\']([^"\']+)["\']', html, re.IGNORECASE)
    result["iframes"] = [
        ifr for ifr in iframes
        if not re.search(r"(google|facebook|twitter|cdn-cgi|disqus|gravatar)", ifr, re.I)
    ][:5]

    # Stream URLs in HTML
    for pattern, fmt in [
        (r"https?://[^\s\"'<>]+\.m3u8[^\s\"'<>]*", "hls"),
        (r"https?://[^\s\"'<>]+\.mpd[^\s\"'<>]*", "dash"),
        (r"https?://[^\s\"'<>]+\.mp4[^\s\"'<>]*", "mp4"),
    ]:
        for m in re.finditer(pattern, html, re.IGNORECASE):
            result["streams"].append({"url": m.group(0).strip().rstrip(")\"'<>,"), "format": fmt})

    # JS variables
    result["js_vars"] = _extract_static_js(html)

    # yt-dlp
    result["yt_dlp"] = _try_yt_dlp(url)

    # Verdict
    result["verdict"] = _generate_static_verdict(result)

    return result


def _classify_page(content_type, html, url):
    """Classify page type from static HTML (most specific first)."""
    text = html.lower()
    if content_type and content_type.startswith("video/"):
        return "direct-video"
    if re.search(r"\.m3u8", text):
        return "hls-stream"
    if re.search(r"\.mpd", text):
        return "dash-stream"
    if re.search(r"(doodcdn|doodstream|playmogo)", text):
        return "doodstream-embed"
    if re.search(r"(hls\.js|hls\.min\.js)", text):
        return "hlsjs-player"
    if re.search(r"(shaka-player|shaka\.compiled)", text):
        return "shaka-player"
    if re.search(r"(video\.js|videojs)", text):
        return "videojs-player"
    if re.search(r"jwplayer", text):
        return "jwplayer"
    if re.search(r"_next/static", text):
        return "client-side-js (nextjs)"
    if re.search(r"(__NUXT__|__VUE__)", text):
        return "client-side-js (vue)"
    if re.search(r"(__NEXT_DATA__|__REACT_DEVTOOLS)", text):
        return "client-side-js (react)"
    return "generic-page"


def _extract_static_js(html):
    """Extract JS variables from static HTML."""
    results = {}
    next_data = re.search(r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if next_data:
        try:
            data = json.loads(next_data.group(1))
            serialized = json.dumps(data)
            urls = re.findall(r"https?://[^\s\"'<>]+\.(?:m3u8|mpd|mp4|webm)[^\s\"'<>]*", serialized)
            if urls:
                results["next_data_video_urls"] = list(set(urls))[:5]
            results["__NEXT_DATA__"] = True
        except json.JSONDecodeError:
            pass
    if re.search(r"window\.__INITIAL_STATE__\s*=", html):
        results["__INITIAL_STATE__"] = "found"
    if re.search(r"window\.__NUXT__\s*=", html):
        results["__NUXT__"] = "found"
    return results


def _generate_static_verdict(result):
    """Generate verdict based on static analysis."""
    parts = []
    classification = result.get("detection", {}).get("classification", "")
    if result.get("streams"):
        parts.append("streams-in-html")
    if classification and "client-side" in classification:
        parts.append("needs-browser-js-render")
    if result.get("iframes"):
        parts.append("iframe-embed-detected")
    yt = result.get("yt_dlp")
    if yt and yt.get("supported") is True:
        parts.append(f"yt-dlp ({yt.get('extractor', 'generic')})")
    if not parts:
        parts.append("no-video-in-static-html")
    return " → ".join(parts)


# ─── Shared: yt-dlp ────────────────────────────────────────────────────────


def _try_yt_dlp(url):
    """Test if yt-dlp supports the URL and return extractor info."""
    if not find_executable("yt-dlp"):
        return {"supported": "unknown", "error": "yt-dlp not installed"}
    try:
        try:
            result = subprocess.run(
                ["yt-dlp", "--dump-json", url],
                capture_output=True, text=True, timeout=30,
            )
        except subprocess.TimeoutExpired:
            result = subprocess.run(
                ["yt-dlp", "--flat-playlist", "--dump-json", url],
                capture_output=True, text=True, timeout=15,
            )
        if result.returncode == 0:
            parsed = json.loads(result.stdout.strip().split("\n")[0])
            formats = parsed.get("formats", [])
            return {
                "supported": True,
                "title": parsed.get("title", ""),
                "extractor": parsed.get("extractor", "generic"),
                "extractor_key": parsed.get("extractor_key", ""),
                "duration": parsed.get("duration"),
                "formats_count": len(formats),
                "best_resolution": max((f.get("height", 0) for f in formats), default=0),
            }
        else:
            return {"supported": False, "error": result.stderr.strip()[:200]}
    except subprocess.TimeoutExpired:
        return {"supported": False, "error": "timeout"}
    except Exception as e:
        return {"supported": False, "error": str(e)[:200]}


# ─── Output Formatters ─────────────────────────────────────────────────────


def _section(name):
    return f"-- {name} " + "-" * max(2, 40 - len(name) - 4)


def _fmt_list(items, label, keys, max_count=8):
    """Format a list of items with selected keys."""
    if not items:
        return []
    lines = ["", _section(f"{label} ({len(items)})")]
    for item in items[:max_count]:
        parts = []
        for key in keys:
            val = item.get(key, "")
            if val:
                parts.append(f"{key}={str(val)[:80]}")
        if parts:
            lines.append("  " + " | ".join(parts))
    return lines


def format_browser_table(result):
    """Format browser analysis as ASCII table."""
    # Handle missing Playwright error
    if "error" in result:
        lines = [f"URL: {result.get('url', '?')}"]
        lines.append("")
        lines.append("-- ERROR --")
        lines.append(f"  {result['error']}")
        if "fix" in result:
            lines.append(f"  Fix: {result['fix']}")
        return "\n".join(lines)

    lines = [f"URL: {result.get('page_info', {}).get('url', '?')}"]
    pi = result.get("page_info", {})
    lines.append("")
    lines.append(_section("Page Info"))
    lines.append(f"  Status:     {pi.get('status', '?')}")
    lines.append(f"  Type:       {pi.get('content_type', '?')}")
    lines.append(f"  Title:      {str(pi.get('title', '?'))[:80]}")
    lines.append(f"  Server:     {pi.get('server', '?')}")
    lines.append(f"  Cloudflare: {pi.get('cloudflare', '?')}")
    if pi.get("navigation_error"):
        lines.append(f"  Nav Error:  {pi['navigation_error'][:80]}")

    videos = result.get("dom_video", [])
    real_videos = [v for v in videos if v.get("src") or (v.get("sourceTags") and v["sourceTags"][0])]
    lines.extend(_fmt_list(real_videos, "Video Elements", ["src", "width", "height", "duration", "hasBlobUrl"]))

    streams = result.get("network_streams", [])
    lines.extend(_fmt_list(streams, "Network Streams", ["url", "type"]))

    iframes = result.get("dom_iframes", [])
    lines.extend(_fmt_list(iframes, "Iframes", ["src", "width", "height"]))

    js = result.get("js_vars", {})
    if js:
        lines.append("")
        lines.append(_section("JS Variables"))
        for k, v in js.items():
            if isinstance(v, list):
                lines.append(f"  {k}:")
                for item in v[:3]:
                    lines.append(f"    {str(item)[:80]}")
            else:
                lines.append(f"  {k}: {v}")

    yd = result.get("yt_dlp")
    if yd:
        lines.append("")
        lines.append(_section("yt-dlp"))
        if yd.get("supported") is True:
            lines.append(f"  Supported:      YES")
            lines.append(f"  Extractor:      {yd.get('extractor', '?')}")
            lines.append(f"  Title:          {str(yd.get('title', '?'))[:60]}")
            lines.append(f"  Best quality:   {yd.get('best_resolution', '?')}p")
            lines.append(f"  Total formats:  {yd.get('formats_count', '?')}")
        else:
            lines.append(f"  Supported:      {yd.get('supported', '?')}")

    lines.append("")
    lines.append(f"-- Verdict -- {result.get('verdict', '?')}")

    return "\n".join(lines)


def format_static_table(result):
    """Format static analysis as ASCII table."""
    lines = [f"URL: {result.get('page_info', {}).get('url', '?')}"]
    pi = result.get("page_info", {})
    lines.append("")
    lines.append(_section("Page Info (Static)"))
    lines.append(f"  Status:     {pi.get('status', '?')}")
    lines.append(f"  Type:       {pi.get('content_type', '?')}")
    lines.append(f"  Title:      {str(pi.get('title', '?'))[:80]}")

    det = result.get("detection", {})
    lines.append("")
    lines.append(_section("Static Detection"))
    lines.append(f"  Classification:     {det.get('classification', '?')}")
    lines.append(f"  Video tags in HTML: {det.get('static_video_elements', 0)}")

    lines.extend(_fmt_list(result.get("streams", []), "Streams in HTML", ["url", "format"]))
    lines.extend(_fmt_list(result.get("iframes", []), "Iframes in HTML", ["url"]))

    yd = result.get("yt_dlp")
    if yd:
        lines.append("")
        lines.append(_section("yt-dlp"))
        if yd.get("supported") is True:
            lines.append(f"  Supported:  YES ({yd.get('extractor', '?')})")
        else:
            lines.append(f"  Supported:  {yd.get('supported', '?')}")

    lines.append("")
    lines.append(f"-- Verdict -- {result.get('verdict', '?')} (static only)")

    return "\n".join(lines)


# ─── Main ───────────────────────────────────────────────────────────────────


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Analyze a video site using a real browser (Playwright)."
    )
    parser.add_argument("url", help="The URL to analyze")
    parser.add_argument(
        "--static",
        action="store_true",
        help="Use HTTP requests only (no browser). Faster but can't see JS-rendered video.",
    )
    parser.add_argument(
        "--output",
        choices=["json", "table"],
        default="table",
        help="Output format (default: table)",
    )
    args = parser.parse_args()

    url = args.url.strip()

    if args.static:
        # Static fallback (no browser)
        result = analyze_static(url)
        result["mode"] = "static"
        if args.output == "json":
            print(json.dumps(result, indent=2, default=str))
        else:
            print(format_static_table(result))
    else:
        # Default: real browser with JS execution
        result = analyze_with_browser(url)
        result["mode"] = "browser"
        if args.output == "json":
            print(json.dumps(result, indent=2, default=str))
        else:
            print(format_browser_table(result))

    sys.exit(0)


if __name__ == "__main__":
    main()
