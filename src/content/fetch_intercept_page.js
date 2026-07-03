/**
 * Page-world fetch/XHR intercept script.
 * Loaded via chrome-extension:// URL to satisfy strict CSP (no inline scripts).
 */
(function () {
  "use strict";

  const INTERCEPT_EVENT = "qwinFetchIntercept";
  const MEDIA_RE = /^(video\/|audio\/|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml)|text\/vtt)/i;
  const SEGMENT_RE = /\.(ts|m4s|m4v|m4a|cmfv|cmfa)(\?|$)/i;
  const MANIFEST_RE = /\.(m3u8|mpd)(\?|$)/i;
  const DIRECT_RE = /\.(mp4|webm|avi|mkv|mov|wmv|flv)(\?|$)/i;
  const MAX_CAPTURES = 5000;
  const MAX_BYTES_PER_RESPONSE = 500 * 1024 * 1024;
  let capturedCount = 0;
  let totalBytes = 0;
  const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

  function looksLikeMediaUrl(url) {
    return SEGMENT_RE.test(url) || MANIFEST_RE.test(url) || DIRECT_RE.test(url);
  }

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function captureResponse(url, contentType, body, status, headers) {
    if (capturedCount >= MAX_CAPTURES) return;
    if (totalBytes >= MAX_TOTAL_BYTES) return;
    if (body.byteLength > MAX_BYTES_PER_RESPONSE) return;
    if (body.byteLength === 0) return;

    capturedCount++;
    totalBytes += body.byteLength;

    const event = new CustomEvent(INTERCEPT_EVENT, {
      detail: {
        type: "qwinMediaResponse",
        url: url,
        contentType: contentType || "",
        bodyLength: body.byteLength,
        bodyB64: bufferToBase64(body),
        status: status,
        headers: JSON.stringify(headers || []),
        isSegment: SEGMENT_RE.test(url),
        isManifest: MANIFEST_RE.test(url),
        capturedAt: Date.now(),
      },
    });
    document.dispatchEvent(event);
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && typeof input === "object" && input.url ? input.url : "";
    if (!url) return originalFetch.call(this, input, init);

    return originalFetch
      .call(this, input, init)
      .then(function (response) {
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (!MEDIA_RE.test(contentType) && !looksLikeMediaUrl(url)) {
          return response;
        }

        const cloned = response.clone();
        cloned
          .arrayBuffer()
          .then(function (body) {
            captureResponse(url, contentType, body, response.status, []);
          })
          .catch(function () {});
        return response;
      })
      .catch(function () {
        return originalFetch.call(this, input, init);
      });
  };

  const OrigXHR = window.XMLHttpRequest;
  const XHRProxy = function () {
    const xhr = new OrigXHR();
    const origOpen = xhr.open.bind(xhr);
    const origSetRequestHeader = xhr.setRequestHeader.bind(xhr);
    let requestUrl = "";
    const requestHeaders = [];

    xhr.open = function (_method, url) {
      requestUrl = typeof url === "string" ? url : "";
      return origOpen.apply(xhr, arguments);
    };

    xhr.setRequestHeader = function (name, value) {
      requestHeaders.push({ name: name, value: value });
      return origSetRequestHeader(name, value);
    };

    xhr.addEventListener("load", function () {
      const contentType = (xhr.getResponseHeader("content-type") || "").toLowerCase();
      if (!MEDIA_RE.test(contentType) && !looksLikeMediaUrl(requestUrl)) return;
      if (!xhr.response || !xhr.response.byteLength) return;

      captureResponse(requestUrl, contentType, xhr.response, xhr.status, requestHeaders);
    });

    xhr.responseType = "arraybuffer";
    return xhr;
  };

  if (OrigXHR.UNSENT !== undefined) XHRProxy.UNSENT = OrigXHR.UNSENT;
  if (OrigXHR.OPENED !== undefined) XHRProxy.OPENED = OrigXHR.OPENED;
  if (OrigXHR.HEADERS_RECEIVED !== undefined) XHRProxy.HEADERS_RECEIVED = OrigXHR.HEADERS_RECEIVED;
  if (OrigXHR.LOADING !== undefined) XHRProxy.LOADING = OrigXHR.LOADING;
  if (OrigXHR.DONE !== undefined) XHRProxy.DONE = OrigXHR.DONE;

  window.XMLHttpRequest = XHRProxy;
})();
