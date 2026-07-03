"use strict";

// ─── Module references ──────────────────────────────────────────────────────
import * as PopupApi from "../shared/popup_api.js";
import * as PopupState from "../shared/popup_state.js";
import { elements, qualityChooser } from "./popup_elements.js";
import {
  setMessage,
  setSettingsStatus,
  setViewMode,
  setSettingsOpen,
  setMusicMode,
  hideQualityDialog,
  showQualityLoading,
  isCurrentQualityRequest,
  chooseQuality,
  refresh,
  updateActiveTabContext,
  shortenUrl,
  normalizeManualUrl,
  isUnknownMessageTypeError,
} from "./popup_helpers.js";

// ─── Settings events ────────────────────────────────────────────────────────

elements.overlayToggle.addEventListener("change", async () => {
  const enabled = elements.overlayToggle.checked;
  const response = await PopupApi.saveSettings({ overlayEnabled: enabled });
  if (!response || !response.ok) {
    setSettingsStatus("Could not save overlay setting.", true);
  } else {
    setSettingsStatus(enabled ? "Overlay enabled." : "Overlay disabled.");
  }

  // Send to the active tab's content script immediately
  await updateActiveTabContext();
  const tabId = PopupState.get("activeTabId");
  if (tabId) {
    const api = typeof browser !== "undefined" ? browser : chrome;
    if (typeof api.tabs !== "undefined" && api.tabs) {
      try {
        if (typeof browser !== "undefined") {
          await api.tabs.sendMessage(tabId, { type: "setOverlayEnabled", enabled });
        } else {
          api.tabs.sendMessage(tabId, { type: "setOverlayEnabled", enabled });
        }
      } catch (_err) {
        // Content script might not be loaded yet
      }
    }
  }
});

elements.recordingMode.addEventListener("change", async () => {
  const response = await PopupApi.saveSettings({
    recordingMode: elements.recordingMode.value,
  });
  if (!response || !response.ok) {
    setSettingsStatus("Could not save recording mode.", true);
  } else {
    setSettingsStatus("Recording mode saved.");
  }
});

if (elements.backend) {
  elements.backend.addEventListener("change", async () => {
    const response = await PopupApi.saveSettings({
      backend: elements.backend.value,
    });
    if (!response || !response.ok) {
      setSettingsStatus("Could not save download method.", true);
    } else {
      setSettingsStatus("Download method saved.");
    }
  });
}

elements.saveSettings.addEventListener("click", async () => {
  const syncEnabled = elements.syncHistoryToggle ? elements.syncHistoryToggle.checked : true;

  PopupApi.setDownloadSyncEnabled(syncEnabled);

  const response = await PopupApi.saveSettings({
    downloadFolder: elements.downloadFolder.value.trim(),
    audioFormat: elements.audioFormat.value,
    recordingMode: elements.recordingMode.value,
    backend: elements.backend ? elements.backend.value : "auto",
    downloadSubtitles: elements.downloadSubtitles ? elements.downloadSubtitles.checked : true,
    downloadSyncEnabled: syncEnabled,
  });
  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Could not save settings.", true);
    return;
  }
  setSettingsStatus("Settings saved.");
});

elements.chooseDownloadFolder.addEventListener("click", async () => {
  setSettingsStatus("");
  elements.chooseDownloadFolder.disabled = true;
  elements.chooseDownloadFolder.textContent = "Opening...";

  const response = await PopupApi.chooseDownloadFolder();

  elements.chooseDownloadFolder.disabled = false;
  elements.chooseDownloadFolder.textContent = "Browse";

  if (!response || !response.ok) {
    if (isUnknownMessageTypeError(response)) {
      setSettingsStatus(
        "Reload Qwin from the browser extensions page, then open settings and click Browse again.",
        true,
      );
      return;
    }
    setSettingsStatus(response && response.error ? response.error : "Could not open the folder picker.", true);
    return;
  }
  if (response.canceled) {
    setSettingsStatus("Folder selection canceled.");
    return;
  }

  elements.downloadFolder.value = (response.settings && response.settings.downloadFolder) || response.path || "";
  setSettingsStatus("Download folder selected.");
});

// ─── Manual URL download ────────────────────────────────────────────────────

elements.downloadManualUrl.addEventListener("click", async () => {
  await updateActiveTabContext();

  const manualUrl = normalizeManualUrl(elements.manualUrl.value);
  if (!manualUrl) {
    setSettingsStatus("Enter a valid http:// or https:// video page URL.", true);
    return;
  }

  setSettingsStatus("");
  elements.downloadManualUrl.disabled = true;
  elements.downloadManualUrl.textContent = "Loading...";
  const requestToken = showQualityLoading("Loading link...");
  const formatsResponse = await PopupApi.getFormatsForUrl(PopupState.get("activeTabId"), {
    url: manualUrl,
    pageUrl: manualUrl,
    title: shortenUrl(manualUrl) || "Manual link",
    format: "PAGE",
    source: "manual-url",
    downloadable: true,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    elements.downloadManualUrl.disabled = false;
    elements.downloadManualUrl.textContent = "Download link";
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideQualityDialog();
    setSettingsStatus(
      formatsResponse && formatsResponse.error
        ? formatsResponse.error
        : "Could not load quality choices for that link.",
      true,
    );
    elements.downloadManualUrl.disabled = false;
    elements.downloadManualUrl.textContent = "Download link";
    return;
  }

  const selectedFormat = await chooseQuality(formatsResponse);
  if (!selectedFormat) {
    elements.downloadManualUrl.disabled = false;
    elements.downloadManualUrl.textContent = "Download link";
    return;
  }

  elements.downloadManualUrl.textContent = "Queued";
  const response = await PopupApi.downloadVideo(
    PopupState.get("activeTabId"),
    formatsResponse.videoId,
    selectedFormat.formatId,
    selectedFormat.variantId,
    selectedFormat.backend,
  );

  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Download failed to start.", true);
  } else {
    setViewMode("downloads");
    setSettingsOpen(false);
  }

  elements.downloadManualUrl.disabled = false;
  elements.downloadManualUrl.textContent = "Download link";
  await refresh();
});

// ─── Magnet download ────────────────────────────────────────────────────────

elements.downloadMagnet.addEventListener("click", async () => {
  const magnetUrl = String(elements.magnetUrl.value || "").trim();
  if (!magnetUrl.startsWith("magnet:?")) {
    setSettingsStatus("Enter a valid magnet link starting with 'magnet:?xt=urn:btih:'.", true);
    return;
  }

  const requestToken = showQualityLoading("Preparing magnet download...");
  const confirmed = await qualityChooser.showChoices({
    choiceTitle: "Download from magnet link",
    formats: [
      {
        id: "magnet",
        label: "Start BitTorrent download",
        ext: "TORRENT",
        note: "Downloads via aria2c",
        source: "magnet",
        size: "",
      },
    ],
  });

  if (!isCurrentQualityRequest(requestToken)) {
    return;
  }

  if (!confirmed) {
    elements.magnetUrl.focus();
    return;
  }

  elements.downloadMagnet.disabled = true;
  elements.downloadMagnet.textContent = "Queued";

  const downloadFolder = elements.downloadFolder.value.trim();
  const response = await PopupApi.downloadMagnet(magnetUrl, downloadFolder);

  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Failed to start magnet download.", true);
  } else {
    setViewMode("downloads");
    elements.magnetUrl.value = "";
  }

  elements.downloadMagnet.disabled = false;
  elements.downloadMagnet.textContent = "Download magnet";
  await refresh();
});

// ─── Torrent file download ──────────────────────────────────────────────────

elements.downloadTorrentFile.addEventListener("click", async () => {
  setSettingsStatus("");
  elements.downloadTorrentFile.disabled = true;
  elements.downloadTorrentFile.textContent = "Opening...";

  const pickResponse = await PopupApi.chooseTorrentFile();

  if (!pickResponse || !pickResponse.ok) {
    if (isUnknownMessageTypeError(pickResponse)) {
      setSettingsStatus("Reload Qwin from the browser extensions page, then open settings and try again.", true);
    } else {
      setSettingsStatus(
        pickResponse && pickResponse.error ? pickResponse.error : "Could not open the file picker.",
        true,
      );
    }
    elements.downloadTorrentFile.disabled = false;
    elements.downloadTorrentFile.textContent = "Download .torrent file";
    return;
  }

  if (pickResponse.canceled || !pickResponse.path) {
    setSettingsStatus("Torrent file selection canceled.");
    elements.downloadTorrentFile.disabled = false;
    elements.downloadTorrentFile.textContent = "Download .torrent file";
    return;
  }

  elements.downloadTorrentFile.textContent = "Queued";
  const downloadFolder = elements.downloadFolder.value.trim();
  const response = await PopupApi.downloadTorrent(pickResponse.path, downloadFolder);

  if (!response || !response.ok) {
    setSettingsStatus(response && response.error ? response.error : "Failed to start .torrent download.", true);
  } else {
    setViewMode("downloads");
    setSettingsOpen(false);
  }

  elements.downloadTorrentFile.disabled = false;
  elements.downloadTorrentFile.textContent = "Download .torrent file";
  await refresh();
});

// ─── Music link download ────────────────────────────────────────────────────

elements.downloadMusicLink.addEventListener("click", async () => {
  await updateActiveTabContext();

  const musicUrl = normalizeManualUrl(elements.musicLinkUrl.value);
  if (!musicUrl) {
    setMessage("Enter a valid Spotify, YouTube Music, or other music service URL.", true);
    elements.musicLinkUrl.focus();
    return;
  }

  if (!PopupState.get("musicMode")) {
    setMusicMode(true);
    await PopupApi.saveSettings({ musicMode: true });
  }

  await PopupApi.saveSettings({ audioFormat: elements.audioFormat.value });

  const requestToken = showQualityLoading("Loading music link...");
  const formatsResponse = await PopupApi.getFormatsForUrl(PopupState.get("activeTabId"), {
    url: musicUrl,
    pageUrl: musicUrl,
    title: shortenUrl(musicUrl) || "Music link",
    format: "PAGE",
    source: "manual-url",
    downloadable: true,
  });

  if (!isCurrentQualityRequest(requestToken)) {
    return;
  }

  if (!formatsResponse || !formatsResponse.ok) {
    hideQualityDialog();
    setMessage(
      formatsResponse && formatsResponse.error ? formatsResponse.error : "Could not load music formats for that link.",
      true,
    );
    return;
  }

  const selectedFormat = await chooseQuality(formatsResponse);
  if (!selectedFormat) {
    return;
  }

  elements.downloadMusicLink.disabled = true;
  elements.downloadMusicLink.textContent = "Queued";
  const response = await PopupApi.downloadVideo(
    PopupState.get("activeTabId"),
    formatsResponse.videoId,
    selectedFormat.formatId,
    selectedFormat.variantId,
    selectedFormat.backend,
  );

  if (!response || !response.ok) {
    setMessage(response && response.error ? response.error : "Download failed to start.", true);
  } else {
    setViewMode("downloads");
    elements.musicLinkUrl.value = "";
  }

  elements.downloadMusicLink.disabled = false;
  elements.downloadMusicLink.textContent = "Download Music";
  await refresh();
});

elements.musicLinkUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    elements.downloadMusicLink.click();
  }
});
