/**
 * Page-world fetch/XHR intercept script.
 * Loaded via chrome-extension:// URL to satisfy strict CSP (no inline scripts).
 */
(function () {
  "use strict";

  var INTERCEPT_EVENT = "qwinFetchIntercept";
  var MEDIA_RE = /^(video\/|audio\/|application\/(x-mpegURL|vnd\.apple\.mpegURL|dash\+xml)|text\/vtt)/i;
  var SEGMENT_RE = /\.(ts|m4s|m4v|m4a|cmfv|cmfa)(\?|$)/i;
  var MANIFEST_RE = /\.(m3u8|mpd)(\?|$)/i;
  var DIRECT_RE = /\.(mp4|webm|avi|mkv|mov|wmv|flv)(\?|$)/i;
  var MAX_CAPTURES = 5000;
  var MAX_BYTES_PER_RESPONSE = 500 * 1024 * 1024;
  var capturedCount = 0;
  var totalBytes = 0;
  var MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

  function looksLikeMediaUrl(url) {
    return SEGMENT_RE.test(url) || MANIFEST_RE.test(url) || DIRECT_RE.test(url);
  }

  function bufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) {
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

    var event = new CustomEvent(INTERCEPT_EVENT, {
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

  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url =
      typeof input === "string"
        ? input
        : input && typeof input === "object" && input.url
          ? input.url
          : "";
    if (!url) return originalFetch.call(this, input, init);

    return originalFetch
      .call(this, input, init)
      .then(function (response) {
        var contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (!MEDIA_RE.test(contentType) && !looksLikeMediaUrl(url)) {
          return response;
        }

        var cloned = response.clone();
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

  var OrigXHR = window.XMLHttpRequest;
  var XHRProxy = function () {
    var xhr = new OrigXHR();
    var origOpen = xhr.open.bind(xhr);
    var origSend = xhr.send.bind(xhr);
    var origSetRequestHeader = xhr.setRequestHeader.bind(xhr);
    var requestUrl = "";
    var requestHeaders = [];

    xhr.open = function (_method, url) {
      requestUrl = typeof url === "string" ? url : "";
      return origOpen.apply(xhr, arguments);
    };

    xhr.setRequestHeader = function (name, value) {
      requestHeaders.push({ name: name, value: value });
      return origSetRequestHeader(name, value);
    };

    xhr.addEventListener("load", function () {
      var contentType = (xhr.getResponseHeader("content-type") || "").toLowerCase();
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
