---
name: failed-download-troubleshooting
description: General-purpose workflow for diagnosing and fixing failed video downloads. Use when a download fails, the wrong URL was sent to backends, or a video plays in the browser but the extension can't download it.
references: tdd, browser-use
---

# Failed Download Troubleshooting

A systematic, general-purpose debugging workflow for failed video downloads. Designed to work for any site, regardless of the root cause.

---

## Core Principle

Every failed download has one of two root causes. But **check both sides** — the real issue is often a combination:

| Category | Symptom | What it means |
|----------|---------|---------------|
| **False Positive** | A non-video URL was detected as downloadable. The bad URL is what gets sent to backends. | The detection system incorrectly flagged something. Block the bad URL pattern. |
| **Incorrectly Blocked Real Stream** | The actual video plays in the browser but the extension never found its stream URL _or_ found it but blocked it. | A legit stream URL is being blocked by a filter that's too broad. Narrow the blocking pattern. |

**Both categories can coexist.** Fixing only one side (e.g., blocking the bad URL) while the real stream remains blocked leaves the user with no valid option. Always check both.

---

## Investigation Phases

### Phase 0: Quick Link Check with curl

When a user provides a link to a video page (e.g., "I can't download from https://example.com/video"), start with a fast curl check to understand what the page serves before diving into code.

This phase runs **before** reading source files — it tells you whether the URL itself is a direct video, an embed page, or something else entirely.

#### 1. Check if the URL is a direct video

```bash
# Check Content-Type header without downloading the body
curl -sI -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://example.com/video.mp4" 2>&1 | findstr -i "content-type content-length"

# If content-type starts with video/, the URL is a direct video file
# If it's text/html, the URL is a web page (not a direct video)
```

#### 2. Fetch the page and check for video patterns

```bash
# Fetch the page HTML
curl -s -L --max-time 15 \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://example.com/video" > page.html

# Check for HLS manifests (most common streaming format)
grep -oi "\.m3u8" page.html | head -5

# Check for DASH manifests
grep -oi "\.mpd" page.html | head -5

# Check for direct video file URLs
grep -oiP "https?://[^\s\"'<>]+\.(?:mp4|webm|m4v)(?:[?#][^\s\"'<>]*)?" page.html | head -10

# Check for video player indicators
grep -oiP "(hls\.js|shaka|video\.js|jwplayer|brightcove|kaltura|dashjs|plyr\.io|flowplayer)" page.html | head -10

# Check for video element source references
grep -oiP "(data-hls|data-video|data-src|data-file|data-source|data-stream|data-url|data-manifest)" page.html | head -10

# Check for file/stream identifiers in cookies or JS config
grep -oiP "[\"'](file_id|video_id|media_id|stream_id|id)[\"']\s*[:=,]\s*[\"']?[a-zA-Z0-9]+" page.html | head -10
```

#### 3. Classify the page

Based on the results, classify what you're dealing with:

| Pattern found | What it means |
|---------------|---------------|
| `.m3u8` | HLS stream — needs HLS downloader (yt-dlp, N_m3u8DL-RE, ffmpeg) |
| `.mpd` | DASH stream — needs DASH downloader (yt-dlp, N_m3u8DL-RE) |
| `.mp4` / `.webm` direct URLs | Direct video — can download with curl/aria2c/requests |
| HLS.js / Shaka / dashjs | Client-side MSE player — stream URL is in JS config or runtime network request |
| Video.js / JWPlayer / Brightcove / Kaltura | Embedded commercial player — stream URL usually in a JSON config or API call |
| `player.php` / `embed` / `iframe` / `e/` path | Embed page — actual video is in a sub-frame or loaded dynamically |
| Cloudflare challenge / 403 | Anti-bot protection — bypass needed (browser cookies, impersonation) |
| `file_id` / `video_id` in cookies/JS | Custom player — a token/ID must be sent to an API endpoint to get the stream URL |

#### 4. Try yt-dlp for a quick extraction check

```bash
# Quick test — does yt-dlp support this site?
yt-dlp --flat-playlist "https://example.com/video" 2>&1

# With Cloudflare bypass if needed
yt-dlp --extractor-args "generic:impersonate" "https://example.com/video" 2>&1
```

#### 5. Try the pass_md5 / token extraction (known pattern)

Many video hosting sites (especially embed-based ones) use a pattern where a token from the page must be sent to an API endpoint to get the signed video URL:

```bash
# Look for the token pattern in the page
grep -oP "/pass_md5/[a-zA-Z0-9_-]+" page.html
grep -oP "/token/[a-zA-Z0-9_-]+" page.html
grep -oP "[\"']/api/[^\"']+[\"']" page.html

# Try calling it
curl -s -e "https://example.com/video" \
  "https://example.com/pass_md5/TOKEN_HERE" 2>&1
```

#### 6. Check for CDN subdomains

```bash
grep -oiP "(cdn|video|stream|media|vod|hls|dash)\.\w+\.(com|net|org|io|tv)" page.html | sort -u
grep -oiP "(cloudfront|akamai|cloudatacdn|doodcdn|fastly|keycdn|bunnycdn)" page.html | head -10
```

This phase should take **under 30 seconds** and gives you a clear picture of the download path before you look at any extension code.

---

### Phase 1: Gather Context

Before looking at any URLs, understand what changed and what exists:

1. **Check recent git changes** — What code was modified recently? Could a previous fix have introduced a regression?
   ```
   git log --oneline -20
   git diff HEAD~5
   ```

2. **Read the troubleshooting log** (`docs/guides/troubleshooting-log.md`) — Has this site or a similar pattern been fixed before?

3. **Read the relevant source files** — At minimum:
   - `src/shared/media_candidates.js` — The blocking regex patterns
   - `src/shared/video_filters.js` — The candidate filtering logic
   - `src/content/content.js` — Content script detection flow
   - `src/background/background.js` — Network interception handlers

4. **Check existing test fixtures** (`tests/fixtures/media_candidate_rules.json`) — What URL patterns are explicitly tested?

---

### Phase 2: Live Investigation (Browser)

Use the `browser-use` agent to investigate what actually happens on the site. This is essential because the page may load dynamic content that isn't visible from static analysis.

1. **Navigate to the failing page** and wait for full load (10+ seconds for ad-heavy / video sites)

2. **Identify video-related elements**:
   - Check for `<video>` elements in the DOM (their `src`, `currentSrc`)
   - Look for blob URLs (HLS.js / Shaka Player style)
   - Note the page title — it often contains the actual video title

3. **Capture network requests** for media streams:
   - Filter for `.m3u8`, `.mpd`, `.mp4`, `.webm`, `.ts`, `.m4s`
   - Look for CDN subdomains (e.g., `video.example.com`, `cdn.example.com`, `stream.example.com`)
   - Note the full URL structure including query parameters and auth tokens

4. **Answer these questions**:
   - What is the actual video stream URL? (Usually a CDN URL with video extension)
   - Is the player using a blob URL? (means HLS.js / MSE — stream comes via network requests)
   - Does clicking the video produce additional network requests? (confirms the player works)
   - What Content-Type does the page itself return? (`text/html` = page, not a video)

---

### Phase 3: Trace Detection Flow

For EACH URL involved (both the bad one detected and the good one that should be detected), trace through the code:

1. **Content script detection paths** (`src/content/content.js`):
   - `scanVideoElements()` — Finds `<video>` elements and creates candidates
   - `scanPerformanceEntries()` — Scans resource load entries
   - `scanInlinePlayerScripts()` — Scans inline scripts for media URLs
   - `scanVisiblePlayerFrames()` — Detects iframe video players
   - `pageFallbackCandidateForVideo()` — Creates a "PAGE" candidate with the page URL as fallback for yt-dlp

2. **Network interception paths** (`src/background/background.js`):
   - `handleBeforeRequest()` — Catches requests before they're sent (type: xmlhttprequest, media, etc.)
   - `handleHeadersReceived()` — Catches responses with content-type headers

3. **For each detection path, ask**:
   - Would this path catch the bad URL? Why?
   - Would this path catch the real stream URL? Why not?
   - What source/format would each detection assign?
   - Would `isLikelyFullLengthVideoCandidate()` filter it out?

---

### Phase 4: Check Filter Status (Direct Testing)

Directly test the actual URLs against the blocking system to verify your understanding:

1. **Check block/allow status** for each URL:
   ```bash
   node -e "
   import('./src/shared/media_candidates.js').then(m => {
     const url = 'https://example.com/suspect-path';
     console.log('isBlockedMediaUrl:', m.isBlockedMediaUrl(url));
     console.log('isDownloadableMediaUrl:', m.isDownloadableMediaUrl(url));
     console.log('classifyMediaUrl:', m.classifyMediaUrl(url));
   });
   "
   ```

2. **Trace which regex blocks/allows** — Create a step-by-step trace of `isBlockedMediaUrl()`:
   ```bash
   node -e "
   import('./src/shared/media_candidates.js').then(m => {
     const text = 'https://example.com/suspect-path'.toLowerCase();
     const checks = [
       ['STATIC_PAGE_ASSET_RE', /\\/(?:stylesheet|theme-color|...)/i],
       ['STATIC_PLAYER_ASSET_RE', /\\.(?:hlsjs|js|css|map)(?:$|[?#])/i],
       ['SEGMENT_EXTENSION_RE', /\\.(ts|mp2t|m4s|cmfv|cmfa)(?:$|[?#])/i],
       ['VIDEO_HOSTING_SITES_RE', /(?:^|[\\/.])(?:flashx|thevideo|...)/i],
       // ... list each pattern from isBlockedMediaUrl in order
     ];
     for (const [name, re] of checks) {
       if (re.test(text)) console.log('BLOCKED by:', name);
     }
   });
   ```

3. **Key insight**: Trace BOTH URLs — the bad one (to confirm it's not blocked when it should be) AND the real stream (to check if it's incorrectly blocked). A real stream being blocked by an overbroad pattern is a common hidden bug.

4. **Common over-blocking patterns to watch for**:
   - `FRAGMENTED_STREAM_CONTEXT_RE + NUMBERED_MEDIA_FRAGMENT_RE` — Can incorrectly block legitimate `.m3u8`/`.mpd` manifests that contain numeric video IDs
   - `SEGMENT_NAME_RE` — Can match legitimate filenames that happen to contain "seg" or "chunk"
   - `STREAMING_PAGE_HOST_RE` / `VIDEO_HOSTING_SITES_RE` — Must check `!VIDEO_EXTENSION_RE.test(text)` to allow CDN streams through

---

### Phase 5: Apply TDD (Test-Driven Fixing)

Once you understand exactly which patterns need changing, follow TDD:

**RED — Write failing test(s):**

Add entries to `tests/fixtures/media_candidate_rules.json`:

```json
{
  "name": "description of the URL",
  "url": "https://actual-url-to-test",
  "contentType": "",
  "format": "EXPECTED_FORMAT",
  "blocked": true,
  "downloadable": false,
  "reusable": false
}
```

Always add fixtures for ALL affected URLs:
- The bad URL → expect `blocked: true`
- The real stream URL → expect `blocked: false`
- Key regression URLs → expect their existing behavior is preserved

Run the test to confirm it **fails** before fixing:
```
node tests/extension/shared/test_video_filters.js
```

**GREEN — Fix production code:**

Edit `src/shared/media_candidates.js` to:
1. Add new blocking pattern for the false positive
2. Fix any overbroad pattern that's blocking real streams (narrow the condition)

Run the test again to confirm it **passes**.

**REFACTOR — Verify no regressions:**

Run comprehensive checks:
```
node tests/extension/shared/test_video_filters.js
```

Also run direct verification of all existing patterns still work:
```bash
node -e "
import('./src/shared/media_candidates.js').then(m => {
  // Known-good URLs should still pass
  console.log('stream.m3u8:', m.isBlockedMediaUrl('https://cdn.example.com/stream.m3u8'));  // false

  // Known-bad URLs should still be blocked
  console.log('segment.ts:', m.isBlockedMediaUrl('https://cdn.example.com/seg-001.ts'));  // true
  console.log('ad.mp4:', m.isBlockedMediaUrl('https://ads.example.com/preroll.mp4'));  // true

  // Video hosting page URLs without extension should be blocked
  console.log('vidfast page:', m.isBlockedMediaUrl('https://vidfast.pro/some-video'));  // true

  // CDN streams from video hosting sites should NOT be blocked
  console.log('vidfast m3u8:', m.isBlockedMediaUrl('https://cdn.vidfast.pro/stream.m3u8'));  // false
});
```
---

### Phase 6: Create a Standalone Download Script

Sometimes the extension's detection pipeline can't be easily fixed (e.g., obfuscated player, Cloudflare-only access, custom DRM), but you can still create a standalone download script that users can run directly.

#### When to create a download script

| Scenario | Example | Script approach |
|----------|---------|-----------------|
| Page has video URL in JS config but extension can't detect it | Video.js / JWPlayer embed | Fetch page, extract URL from JS config, download |
| Page requires a token/API call to resolve the real stream URL | DoodStream / custom players | Fetch page, extract token, call API, download |
| Page behind Cloudflare but video CDN is accessible | Hosting sites with CDN protection | Extract final URL, download with proper Referer |
| yt-dlp supports the site but extension blocks the page URL | Generic video pages | Remove blocklist entry, let yt-dlp handle extraction |

#### General download script template

```python
#!/usr/bin/env python3
"""
download_site.py — Download videos from <site>.

Usage:
    python scripts/download_site.py <url> [output-filename]

Dependencies: requests (pip install requests)
Optional: aria2c
"""

import json
import os
import platform
import re
import subprocess
import sys
import urllib.parse

try:
    import requests
except ImportError:
    print("Install: pip install requests")
    sys.exit(1)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def find_executable(name):
    if platform.system() == "Windows":
        return subprocess.call(
            f"where {name}", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        ) == 0
    return subprocess.call(
        f"which {name}", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ) == 0


def fetch_page(url):
    """Fetch the page HTML with a browser User-Agent."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    return resp.text, resp.url


def extract_video_urls(html_text, base_url):
    """Extract video-related URLs from HTML using multiple strategies.
    
    Override this function for site-specific extraction patterns.
    """
    found = set()
    urls = []

    # Strategy 1: Direct video extension URLs in the HTML
    for match in re.finditer(
        r"""https?://[^\s"'<>]+?\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#][^\s"'<>]*)?(?:\s|"|'|<|>|$)""",
        html_text, re.IGNORECASE,
    ):
        url = match.group(0).strip().rstrip(")\"'<>,")
        if url not in found:
            found.add(url)
            urls.append(url)

    # Strategy 2: JS config / data-attribute video references
    for match in re.finditer(
        r"""(?:data-hls|data-video|data-src|data-url|data-file|data-source
            |"file"|"src"|"url"|"source"|"video"|"playlist"|"manifest")
            \s*[:=]\s*["']([^"']*?(?:\.(?:mp4|m3u8|mpd|webm|ts))[^"']*)["']""",
        html_text, re.IGNORECASE | re.VERBOSE,
    ):
        url = match.group(1).replace("\\/", "/")
        if url.startswith("//"):
            url = f"https:{url}"
        elif url.startswith("/"):
            url = urllib.parse.urljoin(base_url, url)
        if url not in found:
            found.add(url)
            urls.append(url)

    # Strategy 3: Token endpoint patterns (e.g., /pass_md5/, /token/)
    for match in re.finditer(
        r"""["'](/pass_md5/[^"']+)["']|["'](/token/[^"']+)["']""",
        html_text, re.IGNORECASE,
    ):
        path = match.group(1) or match.group(2)
        url = urllib.parse.urljoin(base_url, path)
        # Don't add the token endpoint as a download URL, but return it
        # so the caller can call it to resolve the real stream URL
        if url not in found:
            found.add(url)

    # Strategy 4: Inline scripts (scan <script> tags)
    for script in re.findall(r"<script[^>]*>([^<]+)</script>", html_text, re.IGNORECASE):
        for match in re.finditer(
            r"""https?://[^\s"'<>]+?\.(?:mp4|m4v|webm|m3u8|mpd)(?:[?#][^\s"'<>]*)?""",
            script, re.IGNORECASE,
        ):
            url = match.group(0)
            if url not in found:
                found.add(url)
                urls.append(url)

    return urls


def resolve_token_endpoint(session, token_url, referer_url):
    """Call a token/API endpoint to resolve a signed video URL.
    
    The response may be:
    - A plain-text URL → return it directly
    - A redirect (HTTP 302) → follow and return final URL
    - JSON with a URL field → parse and extract URL
    """
    try:
        resp = session.get(token_url, headers={
            "Referer": referer_url,
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
        }, timeout=30, allow_redirects=True)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"  Token endpoint error: {e}")
        return None

    text = resp.text.strip()

    # Plain URL response
    if text.startswith("http://") or text.startswith("https://"):
        return text

    # Redirect response (final URL differs from request URL)
    if resp.url != token_url and "/404" not in resp.url and "File" not in resp.url:
        return resp.url

    # JSON response with URL field
    try:
        data = json.loads(text)
        for key in ("url", "download", "src", "file", "stream", "redirect", "location"):
            if key in data and isinstance(data[key], str):
                val = data[key]
                if val.startswith("http://") or val.startswith("https://"):
                    return val
    except (json.JSONDecodeError, ValueError):
        pass

    # URL embedded in response text
    url_match = re.search(r"https?://[^\s\"'<>]+(?:\.(?:mp4|m3u8|mpd|webm)[^\s\"'<>]*)", text)
    if url_match:
        return url_match.group(0)

    url_match = re.search(r"https?://[^\s\"'<>]+", text)
    if url_match:
        return url_match.group(0)

    print(f"  Unexpected token response: {text[:200]}")
    return None


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/download_site.py <url> [output-filename]")
        sys.exit(1)

    url = sys.argv[1].strip()
    output_name = sys.argv[2] if len(sys.argv) > 2 else None

    # Step 1: Fetch the page
    print(f"Fetching: {url}")
    try:
        html_text, base_url = fetch_page(url)
    except requests.RequestException as e:
        print(f"  Error: {e}")
        sys.exit(1)

    # Step 2: Extract video URLs
    print("Scanning for video URLs...")
    video_urls = extract_video_urls(html_text, base_url)
    token_urls = [u for u in video_urls if "/pass_md5/" in u or "/token/" in u]
    download_urls = [u for u in video_urls if u not in token_urls]

    final_url = None

    # Step 3: Try token endpoints first
    if token_urls:
        session = requests.Session()
        session.headers.update({"User-Agent": USER_AGENT})
        for token_url in token_urls:
            print(f"  Resolving token: {token_url}")
            resolved = resolve_token_endpoint(session, token_url, base_url)
            if resolved:
                print(f"  Resolved to: {resolved[:100]}...")
                final_url = resolved
                break

    # Step 4: Fall back to direct URLs
    if not final_url and download_urls:
        def priority(u):
            if re.search(r"\.mp4(?:$|[?#])", u, re.IGNORECASE): return 0
            if re.search(r"\.m3u8(?:$|[?#])", u, re.IGNORECASE): return 1
            if re.search(r"\.mpd(?:$|[?#])", u, re.IGNORECASE): return 2
            return 3
        download_urls.sort(key=priority)
        final_url = download_urls[0]

    # Step 5: Try yt-dlp as last resort
    if not final_url:
        if find_executable("yt-dlp") or find_executable("yt-dlp.exe"):
            print("Trying yt-dlp...")
            out = output_name or "%(title)s.%(ext)s"
            result = subprocess.run(["yt-dlp", "-o", out, url])
            if result.returncode == 0:
                return

    if not final_url:
        print("Could not find any video URL.")
        print("Try opening the page in a browser, opening DevTools -> Network,")
        print("finding the video stream, and copying its URL manually.")
        sys.exit(1)

    # Step 6: Download
    if not output_name:
        parsed = urllib.parse.urlparse(final_url)
        filename = os.path.basename(parsed.path)
        if not filename or "." not in filename:
            filename = "video.mp4"
        output_name = filename

    print(f"Downloading to: {output_name}")

    # Try aria2c first (faster)
    if find_executable("aria2c"):
        cmd = ["aria2c", "-x", "4", "-s", "4", "-k", "1M",
               "--header", f"Referer: {base_url}",
               "--header", f"User-Agent: {USER_AGENT}",
               "-o", output_name, final_url]
        if subprocess.run(cmd).returncode == 0:
            print(f"Done: {output_name}")
            return

    # Fallback to requests
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Referer": base_url})
    try:
        resp = session.get(final_url, stream=True, timeout=120)
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        downloaded = 0
        with open(output_name, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = int(downloaded * 100 / total)
                        print(f"\r  {pct}%", end="", flush=True)
        print(f"\nDone: {output_name}")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
```

#### Adapting the script for a specific site

| What to customize | Where | Example |
|-------------------|-------|---------|
| Token extraction pattern | `extract_video_urls()` → Strategy 3 regex | `/pass_md5/[a-zA-Z0-9]+` |
| Video URL pattern | `extract_video_urls()` → Strategy 1/2 | Player JSON config structure |
| API call format | `resolve_token_endpoint()` | POST with form data, or different headers |
| CDN requirements | Download step | Extra cookies, specific origin header |

#### Script output

Save the script as `scripts/download_<site>.py` so it's findable and reusable.

---

## Decision Tree

```
User reports "download failed / wrong video"
│
├─ Phase 0: Quick Link Check with curl
│  ├─ Fetch page, grep for video patterns (.m3u8, .mp4, .mpd)
│  ├─ Check for player type (HLS.js, Video.js, JWPlayer, etc.)
│  ├─ Check for token endpoints (/pass_md5/, /token/)
│  ├─ Check for Cloudflare/anti-bot protection
│  └─ Classify: direct video? embed page? custom player?
│
├─ Phase 1: Gather context
│  └─ git log, troubleshooting log, source files, existing test fixtures
│
├─ Phase 2: Live browser investigation (if needed)
│  └─ Navigate to site, identify video elements, capture stream URLs
│
├─ Phase 3: Trace detection flow
│  └─ For each URL, trace through content script + network interception paths
│
├─ Phase 4: Check filter status (direct testing)
│  ├─ is the bad URL incorrectly not blocked?  → need to add block pattern
│  ├─ is the real stream incorrectly blocked?  → need to narrow existing pattern
│  └─ BOTH? → fix both (the most common scenario)
│
├─ Phase 5: Apply TDD
│  ├─ RED: Add test fixtures, confirm they fail
│  ├─ GREEN: Fix media_candidates.js, confirm they pass
│  └─ REFACTOR: Verify no regressions, check all existing patterns
│
└─ Phase 6: Create standalone download script (if TDD fix isn't sufficient)
   ├─ Player uses obfuscated JS → implement token extraction in script
   ├─ Page requires API call → implement token endpoint resolution
   ├─ CDN blocks direct access → add proper headers to download step
   └─ Save as scripts/download_<site>.py for reuse
```

---

## Common False Positive Patterns (Reference)

| Category | What they look like | Block regex |
|----------|-------------------|-------------|
| Meta tag / HTTP header values | Single path segment like `/theme-color`, `/X-UA-Compatible` | `STATIC_PAGE_ASSET_RE` |
| Player static assets | `provider.hlsjs`, `bundle.js`, `styles.css` | `STATIC_PLAYER_ASSET_RE` |
| Web app manifests | `manifest.webm`, `manifest.json`, `.webmanifest` | `WEB_APP_MANIFEST_RE` |
| Ad / tracking URLs | `doubleclick.net`, `googleads`, `imasdk`, `preroll` | `AD_RE` |
| Stream segments | `segment-00001.ts`, `chunk-42.m4s` | `SEGMENT_EXTENSION_RE` |
| GIF / short clips | `giphy`, `tenor`, `animated-gif`, `loop-preview` | `GIF_VIDEO_RE` |
| CDN ephemeral tokens | `googlevideo.com/videoplayback?range=0-1000` | `isEphemeralMediaUrl()` |
| Video hosting page URLs | Page URLs from sites like flashx, vidoza, beeg without video extension | `VIDEO_HOSTING_SITES_RE` |
| Numbered media fragments | Long numeric IDs + `.mp4` extension in HLS/DASH context (can over-block manifests) | `FRAGMENTED_STREAM_CONTEXT_RE + NUMBERED_MEDIA_FRAGMENT_RE` |

## Common Over-Blocking Traps

These patterns often catch legitimate stream URLs. When fixing, always check if they're too broad:

| Trap | Why it over-blocks | How to narrow |
|------|-------------------|---------------|
| `FRAGMENTED_STREAM_CONTEXT_RE + NUMBERED_MEDIA_FRAGMENT_RE` | `.m3u8`/`.mpd` manifests with numeric video IDs trigger both conditions | Add `!HLS_RE.test(text) && !DASH_RE.test(text)` to exclude manifests |
| `SEGMENT_NAME_RE` | Legitimate filenames containing "seg", "chunk", "part" get blocked | Check that the match is actually a numeric segment pattern, not just a keyword |
| Domain-level host blocking | Subdomain CDN URLs (`video.example.com`) match the same domain regex as page URLs (`example.com`) | Always add `!VIDEO_EXTENSION_RE.test(text)` to allow CDN streams with `.m3u8`/`.mp4` extensions |

## Common curl Check Patterns (Reference)

| Purpose | Command |
|---------|---------|
| Check Content-Type | `curl -sI -A "..." <url> 2>&1 \| findstr -i "content-type"` |
| Find HLS manifests | `grep -oiP "https?://[^\s\"'<>]+\.m3u8[^\s\"'<>]*" page.html` |
| Find direct video URLs | `grep -oiP "https?://[^\s\"'<>]+\.(?:mp4\|webm\|m4v)(?:[?#][^\s\"'<>]*)?" page.html` |
| Find CDN domains | `grep -oiP "(cdn\|video\|stream\|media\|vod)\.\w+\.(com\|net\|org\|io\|tv)" page.html \| sort -u` |
| Find player SDKs | `grep -oiP "(hls\.js\|shaka\|video\.js\|jwplayer\|brightcove\|kaltura\|dashjs\|plyr)" page.html \| sort -u` |
| Find token endpoints | `grep -oP "/pass_md5/[a-zA-Z0-9_-]+" page.html` |
| Find embed paths | `grep -oiP "(embed\|e/)\s*[/=]\s*[\"']?([a-zA-Z0-9_-]+)" page.html` |
| Find file/stream IDs | `grep -oiP "[\"'](?:file_id\|video_id\|media_id\|stream_id)[\"']\s*[:=,]" page.html` |
| Check for Cloudflare | `grep -oi "cloudflare\|cf-ray\|__cfduid" page.html` |
| Check for anti-bot | `grep -oi "challenge-platform\|jsd/main\|_cf_chl_tk" page.html` |

---

## Related Skills

- [`tdd`](../tdd/SKILL.md) — Test-driven development for RED→GREEN workflow
- [`browser-use`](../../tools.md) — Browser automation for live site investigation
- [`systematic-debugging`](../systematic-debugging/SKILL.md) — Root cause investigation before fixing
- [`docs/guides/troubleshooting-log.md`](../../../docs/guides/troubleshooting-log.md) — Record of past fixes with root causes and patterns
