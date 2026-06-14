(function attachQwinVideoPicker(root, factory) {
  const videoPicker = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = videoPicker;
  }
  root.QwinVideoPicker = videoPicker;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinVideoPicker() {
  "use strict";

  function shortenUrl(url) {
    const value = String(url || "").trim();
    if (!value) {
      return "";
    }
    try {
      const parsed = new URL(value);
      const path = parsed.pathname.length > 28 ? `${parsed.pathname.slice(0, 28)}…` : parsed.pathname;
      return `${parsed.hostname}${path}`;
    } catch (_error) {
      return value.length > 42 ? `${value.slice(0, 42)}…` : value;
    }
  }

  function videoTitle(video) {
    return video.title || shortenUrl(video.url) || "Video";
  }

  function displayFormat(video, videoFilters) {
    if (videoFilters && typeof videoFilters.displayVideoFormat === "function") {
      return videoFilters.displayVideoFormat(video);
    }
    return video.format || "VIDEO";
  }

  function sourceLabel(video, videoFilters) {
    if (videoFilters && typeof videoFilters.sourceLabel === "function") {
      return videoFilters.sourceLabel(video);
    }
    if (["M3U8", "MPD", "YOUTUBE"].includes(String(video.format || "").toUpperCase())) {
      return "full video";
    }
    if (video.source === "manual-url") {
      return "manual link";
    }
    return video.source || "detected";
  }

  function videoSizeLabel(video, videoFilters) {
    if (videoFilters && typeof videoFilters.displayVideoSize === "function") {
      return videoFilters.displayVideoSize(video);
    }
    return video.size || "";
  }

  function createPickerItem(document, video, options = {}) {
    const videoFilters = options.videoFilters || null;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "video-item video-picker-item";
    item.title = video.url || videoTitle(video);

    const content = document.createElement("div");
    content.className = "video-content";

    const title = document.createElement("div");
    title.className = "video-title";
    title.textContent = videoTitle(video);

    const meta = document.createElement("div");
    meta.className = "meta";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = displayFormat(video, videoFilters);

    const source = document.createElement("span");
    source.textContent = video.variantCount > 1 ? `${video.variantCount} versions` : sourceLabel(video, videoFilters);

    meta.append(badge, source);

    const sizeLabel = videoSizeLabel(video, videoFilters);
    if (sizeLabel) {
      const size = document.createElement("span");
      size.className = "video-size";
      size.textContent = sizeLabel;
      meta.append(size);
    }

    content.append(title, meta);
    item.append(content);

    if (typeof options.onSelect === "function") {
      item.addEventListener("click", () => options.onSelect(video));
    }

    return item;
  }

  function renderList(container, videos, options = {}) {
    const doc = container.ownerDocument || options.document;
    container.textContent = "";
    const items = Array.isArray(videos) ? videos : [];

    if (!items.length) {
      const empty = doc.createElement("div");
      empty.className = "qwin-overlay-empty";
      empty.textContent = options.emptyText || "No downloadable video detected yet.";
      container.append(empty);
      return;
    }

    for (const video of items) {
      container.append(createPickerItem(doc, video, options));
    }
  }

  return {
    createPickerItem,
    renderList,
    videoTitle,
    displayFormat,
    sourceLabel,
    videoSizeLabel,
  };
});
