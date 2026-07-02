---
name: tdd-e2e
description: Outside-In TDD for Qwin Video Downloader. Write a failing E2E test for a site URL, then drive inner-loop development (filter rules, native messaging, download backends, CDM decryption) with focused unit tests.
references: tdd, failed-download-troubleshooting, verification-before-completion
---

# E2E Test-Driven Development (Outside-In TDD) for Qwin

> **Input:** a site URL. **Output:** extension detects and downloads videos from that site.

## Overview

Write a failing E2E test that loads the site in Playwright with the extension loaded. Then decompose into layers (content script → media candidates → native messaging → Python host → Go CDM) and drive each with unit tests. Never build what the E2E test doesn't demand.

## Workflow

### Phase 0: Analyze the Site

**Prerequisites (one-time):**
```bash
pip install playwright
playwright install chromium
```

Analyze the site using a **real browser** — this renders JavaScript, so it can see actual `<video>` elements, intercept HLS/DASH network requests, and extract JS player configs:

```bash
python scripts/analyze-site.py "https://example.com/video"
```

For a quick static check (no browser, only sees raw HTML):
```bash
python scripts/analyze-site.py "https://example.com/video" --static
```

**Common verdicts (browser mode):**

| Verdict | Detection path |
|---------|----------------|
| `real-video (HLS detected)` | Actual `<video>` with HLS stream → direct download / MSE intercept |
| `real-video (blob:// MSE player)` | MSE player (HLS.js/Shaka) → MSE intercept in content script |
| `hls-stream (N found)` | HLS manifests captured from network → aria2c/yt-dlp |
| `iframe-embed → playmogo.com` | Iframe detected → content script captures iframe URL |
| `hls.js-detected` | HLS.js SDK found on page → MSE intercept path |
| `no-video-detected` | Browser loaded page but found no video → try yt-dlp or browser-use agent |

### Phase 1: Write Failing E2E Test (RED — Outer Loop)

```typescript
// tests/e2e/sites/site-name.spec.ts
test('detects video from example.com', async () => {
  // Launch browser with extension from dist/chromium/
  // Navigate to site URL
  // Wait for #qwin-overlay
  // Check candidates received via window message
});
```

**Run:** `npm run test:e2e -- tests/e2e/sites/site-name.spec.ts` — confirm FAIL.

### Phase 2: Decompose

Break the E2E test into components by layer:

```
Layer 1: Content script detection — <video> elements, MSE, SW capture
Layer 2: Media candidate filtering — media_candidates.js rules
Layer 3: Native messaging — background → Python host protocol
Layer 4: Download backend — yt-dlp, aria2c, gopeed adapters
Layer 5: CDM decryption (DRM only) — Go qwin-capture
```

### Phase 3: Drive Inner Loops (RED → GREEN → REFACTOR)

For each layer, write a failing unit test, implement minimal code, verify pass.

**media_candidates.js:**
```typescript
// RED
test('allows cdn.example.com/stream.m3u8', () => {
  expect(isBlockedMediaUrl('https://cdn.example.com/stream.m3u8')).toBe(false);
});
test('blocks example.com page URL', () => {
  expect(isBlockedMediaUrl('https://example.com/video')).toBe(true);
});

// Verify RED
node tests/extension/shared/test_video_filters.js

// GREEN — add domain to VIDEO_HOSTING_SITES_RE
```

**Python adapter:**
```python
# RED
def test_download_format():
    result = download('https://example.com/video')
    assert result['status'] == 'started'

# Verify RED
python -m pytest tests/native-host/test_download_manager.py -v

# GREEN — implement adapter logic
```

**Go CDM (if DRM):**
```go
// RED
func TestExtractKey(t *testing.T) {
    key, err := extractContentKey(license, initData)
    if err != nil { t.Fatal(err) }
    if len(key) != 16 { t.Error("expected 16 bytes") }
}

// Verify RED
cd go && go test -run TestExtractKey -v

// GREEN — implement key extraction
```

### Phase 4: Run E2E Test (GREEN — Outer Loop)

```bash
npm run test:e2e -- tests/e2e/sites/site-name.spec.ts
```

If it fails, drop back into inner loop for the broken layer.

## Test Commands

| Suite | Command |
|-------|---------|
| All tests | `npm run test` |
| Extension | `npm run test:extension` |
| Native host | `npm run test:native` |
| Go tests | `cd go && go test ./...` |
| Single JS | `node tests/extension/shared/test_video_filters.js` |
| Single Python | `python -m pytest tests/native-host/test_file.py -v` |
| Site analysis | `python scripts/analyze-site.py <url>` |

## Related Skills

| Skill | When |
|-------|------|
| `@tdd` | Classic unit TDD for isolated utilities |
| `@e2e-tdd` (this) | Feature-level TDD starting from a site URL |
| `@failed-download-troubleshooting` | Debugging a specific failed download |
| `@verification-before-completion` | Before claiming a fix works |
