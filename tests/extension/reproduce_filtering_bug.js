const path = require('path');
const assert = require('assert');

globalThis.QwinMediaCandidates = require(path.resolve(__dirname, '../../src/shared/media_candidates.js'));
const videoFilters = require(path.resolve(__dirname, '../../src/shared/video_filters.js'));

console.log('Running Video Filtering Bug Reproduction Tests...');

try {
  // 1. Blob URL should be accepted as downloadable
  const blobUrl = 'blob:https://example.com/uuid';
  assert.strictEqual(videoFilters.isDownloadableUrl(blobUrl, ''), true, 'Blob URL should be downloadable');

  // 2. URL with range parameter should NOT be blocked
  const rangeUrl = 'https://cdn.example.com/video.mp4?range=0-1000';
  assert.strictEqual(videoFilters.isBlockedVideoUrl(rangeUrl, ''), false, 'Range URL should NOT be blocked');

  // 3. DOM-sourced video with "clip" in title should be accepted
  const domVideo = {
    url: 'https://example.com/video.mp4',
    source: 'dom-video',
    title: 'Episode 1 Clip',
    duration: 1200,
    width: 1920,
    height: 1080
  };
  assert.strictEqual(videoFilters.isLikelyFullLengthVideoCandidate(domVideo), true, 'DOM video should bypass keyword filters');

  // 4. DOM-sourced video with duration 0 should be accepted
  const domVideoNoDuration = {
    url: 'https://example.com/video.mp4',
    source: 'dom-video',
    duration: 0,
    width: 1920,
    height: 1080
  };
  assert.strictEqual(videoFilters.isLikelyFullLengthVideoCandidate(domVideoNoDuration), true, 'DOM video with duration 0 should be accepted');

  console.log('Reproduction tests finished.');
} catch (error) {
  console.error('Test failed!');
  console.error(error);
  process.exit(1);
}
