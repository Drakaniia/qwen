# E2E TDD Reference Guide

> Full reference for the Outside-In TDD workflow. SKILL.md is the concise entry point; this file contains all detailed examples, anti-patterns, checklists, and background.

## The Double Loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                   OUTER LOOP (E2E — Playwright)                      │
│                                                                      │
│  1. Write E2E test for site URL → watch it fail                      │
│  2. Break down what components are needed                            │
│  3. Drive inner loops for each component                             │
│  4. Run E2E test again → now passes                                  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐     │
│  │              INNER LOOPS (per component)                     │     │
│  │                                                               │     │
│  │  For each layer below, do RED → GREEN → REFACTOR:             │     │
│  │                                                               │     │
│  │  Layer 1:  media_candidates.js — filter rules                 │     │
│  │  Layer 2:  video_filters.js — candidate filtering             │     │
│  │  Layer 3:  background.js — download orchestration             │     │
│  │  Layer 4:  Python host — download_manager / adapter           │     │
│  │  Layer 5:  Go CDM — decryption (if DRM)                      │     │
│  └─────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

## Architecture Layers

```
┌──────────────────────────────────────────────────────────┐
│                    OUTER LOOP (E2E)                        │
│  Playwright loads site → extension detects → downloads     │
├──────────────────────────────────────────────────────────┤
│  Inner Loops:                                              │
│                                                           │
│  ┌─ src/content/      ─┐  Page detection, MSE intercept    │
│  │  content.js          │  fetch_intercept.js               │
│  │  eme_intercept.js    │  service_worker_capture.js        │
│  └─────────────────────┘                                   │
│  ┌─ src/shared/       ─┐  Media candidate filtering        │
│  │  media_candidates.js │  video_filters.js                 │
│  │  video_identity.js   │  quality_format.js                │
│  └─────────────────────┘                                   │
│  ┌─ src/background/   ─┐  Download orchestration           │
│  │  native_requests.js  │  segment_capture.js               │
│  │  sw_relay.js         │  cdp_helpers.js                   │
│  └─────────────────────┘                                   │
│  ┌─ src/native_host/  ─┐  Python native messaging host     │
│  │  host.py             │  download_manager.py              │
│  │  capture_manager.py  │  yt_dlp_adapter.py                │
│  │  aria2c_commands.py  │  gopeed_adapter.py                │
│  │  media_resolver.py   │  stream_backends.py               │
│  │  cdm_capture.py      │  bittorrent_downloads.py          │
│  │  curl_cffi_adapter.py│  spotify_resolver.py              │
│  └─────────────────────┘                                   │
│  ┌─ go/               ─┐  Go CDM companion binary          │
│  │  cdm.go             │  decrypt.go                         │
│  │  commands.go        │  main.go                            │
│  └─────────────────────┘                                   │
└──────────────────────────────────────────────────────────┘
```

## The Iron Laws

```
LAW 1: NO PRODUCTION CODE WITHOUT A FAILING E2E TEST FIRST
LAW 2: NO INNER-LOOP CODE WITHOUT A FAILING UNIT TEST FIRST
LAW 3: YOU ONLY BUILD WHAT THE E2E TEST DEMANDS
```

Both loops require seeing a test fail before implementing. If you didn't watch it fail, you don't know if it tests the right thing.

---

## Detailed Workflow

### Phase 0: Understand the Site URL

When you receive a site URL, first understand what you're dealing with before writing any tests:

```bash
# Fetch the page and check for video patterns
curl -sL --max-time 15 \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://example.com/video" > page.html

# Check for HLS manifests
grep -oi "\.m3u8" page.html | head -5

# Check for DASH manifests
grep -oi "\.mpd" page.html | head -5

# Check for direct video files
grep -oiP "https?://[^\s\"'<>]+\.(?:mp4|webm|m4v)(?:[?#][^\s\"'<>]*)?" page.html | head -10

# Check for player type
grep -oiP "(hls\.js|shaka|video\.js|jwplayer|brightcove|dashjs|plyr)" page.html | head -10

# Check for token endpoints
grep -oP "/pass_md5/[a-zA-Z0-9_-]+" page.html
```

**Classify the site:**

| Pattern found | Detection path |
|---------------|----------------|
| `.m3u8` manifest | HLS detection → yt-dlp / aria2 |
| `.mpd` manifest | DASH detection → yt-dlp / aria2 |
| Direct `.mp4` URLs | Direct download |
| HLS.js / Shaka | MSE intercept in content script |
| Video.js / JWPlayer | JS config extraction |
| `/pass_md5/` token | Token endpoint → Python resolve |
| DRM / Widevine | EME intercept → Go CDM path |
| Cloudflare challenge | curl_cffi impersonation |

---

### Phase 1: RED (Outer Loop) — Write a Failing E2E Test

Write an E2E test using Playwright that loads the extension, navigates to the site URL, and verifies the extension detects the video.

<Good> — Project-specific E2E test for a video site:

```typescript
// tests/e2e/sites/vidfast-pro.spec.ts
import { test, expect, chromium } from '@playwright/test';
import path from 'path';

const EXTENSION_PATH = path.resolve(__dirname, '../../dist/chromium');

test('detects and downloads video from vidfast.pro', async () => {
  // Launch browser with extension loaded
  const userDataDir = `/tmp/test-user-data-${Date.now()}`;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  const page = await context.newPage();

  // Navigate to the video page
  await page.goto('https://vidfast.pro/some-video-id', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  // Wait for extension content script to inject overlay
  await page.waitForSelector('#qwin-overlay', { timeout: 10000 });

  // Verify the extension detected a video candidate
  const candidates = await page.evaluate(() => {
    return new Promise((resolve) => {
      // Listen for extension message with detected media
      window.addEventListener('message', (event) => {
        if (event.data?.type === 'QWIN_MEDIA_DETECTED') {
          resolve(event.data.candidates);
        }
      });
      // Trigger detection if needed
      window.postMessage({ type: 'QWIN_REQUEST_DETECTION' }, '*');
      // Timeout fallback
      setTimeout(() => resolve([]), 5000);
    });
  });

  expect(candidates).toBeDefined();
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates[0]).toMatchObject({
    url: expect.stringContaining('.m3u8'),
    format: 'hls',
    quality: expect.stringMatching(/1080|720|480/),
  });

  // Verify the popup would show this candidate
  const popupPage = await context.newPage();
  await popupPage.goto(
    `chrome-extension://${await getExtensionId(context)}/popup/popup.html`
  );
  await expect(popupPage.locator('.download-item')).toHaveCount(1);

  await context.close();
});

async function getExtensionId(context: any): Promise<string> {
  const backgroundPage = context.serviceWorkers[0]?.url();
  if (!backgroundPage) throw new Error('No service worker found');
  return backgroundPage.match(/chrome-extension:\/\/([^/]+)/)![1];
}
```

</Good>

<Bad> — Generic test that bypasses the extension:

```typescript
test('download works', async () => {
  const res = await fetch('https://example.com/video.mp4');
  expect(res.status).toBe(200);
});
```

**Requirements:**
- Loads the actual extension build (`dist/chromium/`, `dist/yandex/`)
- Navigates to the real site URL (provided by user)
- Verifies the extension's video detection works
- Checks the popup shows detected candidates
- Uses the project's Playwright setup

---

### Phase 2: DESIGN — Break It Down

Decompose what the E2E test needs. For a video site, the breakdown follows the architecture layers:

```
E2E Test: Detect video from vidfast.pro
│
├── Layer 1: Content Script Detection
│   ├── Does the page have <video> elements?
│   ├── Does the page load HLS.js? (MSE intercept)
│   ├── Does the page use a JWPlayer/Video.js embed?
│   └── Is there a /pass_md5/ token endpoint?
│
├── Layer 2: Media Candidate Filtering
│   ├── Is the detected URL blocked by media_candidates.js?
│   ├── Is vidfast.pro in VIDEO_HOSTING_SITES_RE?
│   ├── Does the CDN URL pass through (not blocked)?
│   └── Are fake candidates (ads, previews) filtered out?
│
├── Layer 3: Native Messaging
│   ├── Are candidates correctly sent to Python host?
│   └── Does the host receive the right format/quality?
│
├── Layer 4: Download Backend
│   ├── Does yt-dlp support this site? (yt_dlp_adapter)
│   ├── Does aria2c work for HLS streams? (aria2c_commands)
│   └── Does gopeed work? (gopeed_adapter)
│
└── Layer 5: CDM Decryption (if DRM)
    ├── Does EME intercept catch the license request?
    ├── Does Python relay to Go qwin-capture?
    └── Does CDM extract the content key?
```

Pick the **outermost** failing component first (what's closest to the user/page) and drop into the inner loop.

---

### Phase 3: RED (Inner Loop) — Write Failing Unit Tests

For each component identified in the breakdown, write a unit test. Watch it fail.

#### Filter Rules in media_candidates.js

```typescript
// tests/extension/shared/test_media_candidates.js
import {
  isBlockedMediaUrl,
  isDownloadableMediaUrl,
  classifyMediaUrl,
} from '../../../src/shared/media_candidates.js';

test('allows vidfast.pro HLS manifest through filter', () => {
  const url = 'https://cdn.vidfast.pro/stream/abc123/index.m3u8';
  expect(isBlockedMediaUrl(url)).toBe(false);
  expect(isDownloadableMediaUrl(url)).toBe(true);
  expect(classifyMediaUrl(url)).toBe('hls');
});

test('blocks vidfast.pro page URL (no video extension)', () => {
  const url = 'https://vidfast.pro/some-video-id';
  expect(isBlockedMediaUrl(url)).toBe(true);
  expect(isDownloadableMediaUrl(url)).toBe(false);
});

test('blocks vidfast.pro ad URLs', () => {
  const url = 'https://vidfast.pro/ads/preroll.mp4';
  expect(isBlockedMediaUrl(url)).toBe(true);
});
```

```bash
node tests/extension/shared/test_video_filters.js
# Expected: FAIL — these URLs don't match existing patterns
```

#### Python Download Backend in yt_dlp_adapter.py

```python
# tests/native-host/test_yt_dlp_adapter.py
import unittest
from src.native_host.yt_dlp_adapter import get_best_quality, extract_info

class TestVidfastYtDlpAdapter(unittest.TestCase):
    def test_extract_info_returns_formats(self):
        result = extract_info('https://vidfast.pro/some-video-id')
        self.assertIn('formats', result)
        self.assertGreater(len(result['formats']), 0)

    def test_get_best_quality_returns_1080p(self):
        formats = [
            {'format_id': '360', 'height': 360},
            {'format_id': '720', 'height': 720},
            {'format_id': '1080', 'height': 1080},
        ]
        best = get_best_quality(formats)
        self.assertEqual(best['height'], 1080)

if __name__ == '__main__':
    unittest.main()
```

```bash
python -m pytest tests/native-host/test_yt_dlp_adapter.py -v
# Expected: FAIL
```

#### Go CDM Decryption

```go
// go/cdm_test.go
package main
import "testing"

func TestExtractContentKeyFromLicense(t *testing.T) {
    key, err := extractContentKey(licenseResponse, initData)
    if err != nil { t.Fatalf("unexpected error: %v", err) }
    if len(key) != 16 { t.Errorf("expected 16-byte key, got %d bytes", len(key)) }
}

func TestDecryptAES128CTRSegment(t *testing.T) {
    decrypted, err := decryptAES128CTR(encrypted, key, iv)
    if err != nil { t.Fatalf("decryption failed: %v", err) }
    if string(decrypted[4:8]) != "ftyp" {
        t.Errorf("decrypted data doesn't look like MP4")
    }
}
```

```bash
cd go && go test -run TestExtractContentKeyFromLicense -v
# Expected: FAIL — function not defined
```

#### Native Messaging Protocol

```python
# tests/native-host/test_host_commands.py
import unittest
from src.native_host.host_dispatch import handle_message

class TestVidfastHostDispatch(unittest.TestCase):
    def test_handle_download_message(self):
        message = {
            'command': 'download',
            'url': 'https://cdn.vidfast.pro/stream/abc123/index.m3u8',
            'format': 'hls',
            'quality': '1080',
            'output_path': 'C:\\Downloads\\video.mp4',
        }
        result = handle_message(message)
        self.assertIn('status', result)
        self.assertEqual(result['status'], 'started')

    def test_rejects_invalid_url(self):
        message = {
            'command': 'download',
            'url': 'https://vidfast.pro/page-only',
            'format': 'hls',
        }
        result = handle_message(message)
        self.assertEqual(result['status'], 'error')
        self.assertIn('Invalid URL', result.get('error', ''))

if __name__ == '__main__':
    unittest.main()
```

---

### Phase 4: GREEN — Implement Minimal Code

#### Adding vidfast.pro to media_candidates.js

```javascript
// In src/shared/media_candidates.js
const VIDEO_HOSTING_SITES_RE = /(?:^|[\\/.])(?:vidfast|flashx|thevideo|vidoza|...)/i;
```

#### Implementing yt-dlp adapter for HLS

```python
# In src/native_host/yt_dlp_adapter.py
def get_best_quality(formats):
    return max(formats, key=lambda f: f.get('height', 0))
```

#### Implementing Go key extraction

```go
// In go/cdm.go
func extractContentKey(license, initData []byte) ([]byte, error) {
    return make([]byte, 16), nil
}
```

---

### Phase 5: Verify GREEN — Watch Tests Pass

```bash
# JS tests
node tests/extension/shared/test_video_filters.js

# Python tests
python -m pytest tests/native-host/test_yt_dlp_adapter.py -v

# Go tests
cd go && go test ./...
```

Confirm: test passes, no other tests broke, output clean.

---

### Phase 6: Run E2E Test Again (GREEN — Outer)

```bash
npm run test:e2e -- tests/e2e/sites/vidfast-pro.spec.ts
```

If it fails, identify which component is missing, drop back into inner loop.

---

## Concrete Example: Adding Support for a New Site

### Step 1: User provides URL
> "vidfast.pro isn't downloading"

### Step 2: Phase 0 — Understand the site
```bash
curl -sL https://vidfast.pro/some-video-id | grep -oi "\.m3u8\|\.mp4\|hls\.js\|jwplayer\|pass_md5"
```
Discovers: HLS.js + `/pass_md5/` token endpoint.

### Step 3: Write failing E2E test (RED — Outer)
```typescript
test('detects HLS stream from vidfast.pro', async ({ context, page }) => {
  await page.goto('https://vidfast.pro/test-video-123');
  // ... full Playwright pattern above
});
```

### Step 4: Break it down
```
Layer 1: vidfast.pro site blocked by VIDEO_HOSTING_SITES_RE?
Layer 2: CDN URL allowed through? (cdn.vidfast.pro/stream/*.m3u8)
Layer 3: Token endpoint /pass_md5/ needs Python resolver
```

### Step 5: Inner loop — media_candidates.js
```typescript
test('allows cdn.vidfast.pro HLS stream', () => {
  expect(isBlockedMediaUrl('https://cdn.vidfast.pro/stream/abc/index.m3u8')).toBe(false);
});
test('blocks vidfast.pro page URL', () => {
  expect(isBlockedMediaUrl('https://vidfast.pro/test-video-123')).toBe(true);
});
```
Add `vidfast` to `VIDEO_HOSTING_SITES_RE`.

### Step 6: Inner loop — Python media_resolver
```python
def test_resolve_vidfast_token():
    resolved = resolve_token_endpoint(
        'https://vidfast.pro/pass_md5/abc123',
        'https://vidfast.pro/test-video-123'
    )
    assert resolved.startswith('https://')
    assert '.m3u8' in resolved
```

### Step 7: E2E test passes (GREEN — Outer)
```bash
npx playwright test tests/e2e/sites/vidfast-pro.spec.ts
✓ detects HLS stream from vidfast.pro (4.2s)
```

---

## Testing Anti-Patterns

| Anti-Pattern | Why It Fails | Fix |
|---|---|---|
| E2E test navigates to site but doesn't check extension state | Tests page load, not extension | Verify `#qwin-overlay`, popup, or background messages |
| Unit test mocks entire native messaging layer | Tests mock, not real protocol | Mock at boundary only (stdin/stdout) |
| Run E2E without curl check first | Waste time on automation-blocking sites | Always do Phase 0 first |
| Only tests one layer | E2E passes, download fails at Python/Go layer | Test full stack |
| Only tests happy path | Edge cases (ads, expired tokens) slip through | Add negative tests |
| Adding too many URL fixtures without testing | Tests become unreadable | One fixture per URL type |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "I'll just add the domain, no test needed" | You'll break related patterns. Test it. |
| "E2E is too slow for every change" | Run once per feature. Inner loops run constantly. |
| "I'll fix the filter rule and test later" | Tests-after don't prove the fix works. |
| "Phase 0 curl check is overkill" | It saves 20min of debugging. |

## Verification Checklist

- [ ] Phase 0 curl check done — understand site's video delivery
- [ ] E2E test written FIRST for site URL (RED — outer loop)
- [ ] Watched E2E test fail meaningfully
- [ ] Feature decomposed by architecture layer
- [ ] Each layer had a failing unit test FIRST (RED — inner loop)
- [ ] Watched each unit test fail before implementing
- [ ] Wrote minimal code to pass each unit test
- [ ] Refactored after each green inner loop
- [ ] All inner-loop tests pass (JS + Python + Go)
- [ ] `npm run test` passes (no regressions)
- [ ] E2E test passes (GREEN — outer loop)
- [ ] Edge cases covered:
  - Page URL blocked, CDN stream allowed
  - Token endpoint resolves correctly
  - Ad/preview URLs blocked
  - Expired/invalid tokens rejected

## Test Commands

| Suite | Command |
|-------|---------|
| All tests | `npm run test` |
| Extension | `npm run test:extension` |
| Native host | `npm run test:native` |
| Go tests | `cd go && go test ./...` |
| E2E (individual) | `npx playwright test tests/e2e/sites/...` |
| Single JS | `node tests/extension/shared/test_video_filters.js` |
| Single Python | `python -m pytest tests/native-host/test_file.py -v` |

## Relationship to Other Skills

| Skill | When |
|-------|------|
| `@tdd` | Classic unit TDD for isolated utilities |
| `@e2e-tdd` (this) | Feature-level TDD starting from a site URL |
| `@failed-download-troubleshooting` | Debugging a specific failed download |
| `@verification-before-completion` | Before claiming any fix works |

## Further Reading

- [Obey the Testing Goat — Outside-In TDD](https://www.obeythetestinggoat.com/book/chapter_24_outside_in.html)
- [Playwright Chrome Extensions](https://playwright.dev/docs/chrome-extensions)
- [Chrome Developers — E2E Testing Extensions](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing)
