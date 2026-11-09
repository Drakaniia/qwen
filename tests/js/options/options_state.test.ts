/**
 * The options page's persistence path (spec §8).
 *
 * Four things worth pinning here. First, that a setting is written through
 * `saveSettings`, which the background *merges* onto its settings — a page that sent a
 * whole object would clobber keys another page owns, which is exactly how a direct
 * `storage.local` write gets erased by the next save. Second, that the theme is written
 * as one of three named modes and that `"system"` is represented by *removing* the
 * attribute rather than by writing the string. Third, that a confirmation is scoped to
 * the control it belongs to, which is the whole point of the per-control note. Fourth,
 * that the overlay toggle pushes `setOverlayEnabled` at the open tab: saving alone would
 * leave an already-open page showing the old state until reload.
 *
 * `autoDownload`, which the spec flagged as dead, has no assertion here on purpose —
 * this file asserts it is *absent* from what the page sends, which is the only form that
 * test can take. `maxConcurrentDownloads` is live again (the background's queue reads
 * it), so it has real tests below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIO_FORMATS,
  clearHistory,
  commit,
  filterLists,
  helper,
  historyCount,
  loadAll,
  loadFilterLists,
  loadHelperStatus,
  loadSettings,
  note,
  query,
  saveSetting,
  setOverlayEnabled,
  setSyncEnabled,
  setTheme,
  settings,
  SETTINGS_STORAGE_KEY,
  type Settings,
} from "../../../src/popup/options/state.js";

let sent: Array<Record<string, unknown>> = [];

/**
 * `browser_api` is callback-mode in these tests and calls `sendMessage(message, cb)`,
 * which the MV3 overload set in `@types/chrome` does not describe. One cast, here,
 * rather than five.
 */
type Callback = (response: unknown) => void;
type SendMessage = (message: unknown, callback?: Callback) => void;

function mockSendMessage(handler: SendMessage): void {
  (chrome.runtime.sendMessage as unknown as { mockImplementation: (fn: SendMessage) => void }).mockImplementation(
    handler,
  );
}

const STORED_SETTINGS: Settings = {
  downloadFolder: "",
  audioFormat: "mp3",
  overlayEnabled: true,
  downloadSyncEnabled: true,
  theme: "system",
  minSizeBytes: null,
  downloadSubtitles: true,
  maxConcurrentDownloads: 3,
  preferredMaxHeight: 0,
};

/**
 * The background's own copy, mutated by `saveSettings`.
 *
 * Not a constant: `tab_state.updateSettings` merges onto its in-memory object and
 * `getSettings` reads that same object back, so a mock that always answered with a
 * fixed record would silently undo every save the page makes and hide the very thing
 * the theme tests are about.
 */
let store: Settings = { ...STORED_SETTINGS };

function stubChrome(response: Record<string, unknown> = {}) {
  sent = [];
  store = { ...STORED_SETTINGS };
  mockSendMessage((message, callback) => {
    const request = message as Record<string, unknown>;
    sent.push(request);

    let reply: unknown = { ok: true, ...response };
    if (request.type === "saveSettings") {
      store = { ...store, ...(request.settings as Partial<Settings>) };
      reply = { ok: true, settings: store };
    }
    if (request.type === "getSettings") {
      reply = { ok: true, settings: store };
    }
    if (request.type === "getDownloadSyncHistory") {
      reply = { ok: true, history: [], syncInfo: { totalCount: 7, syncEnabled: true } };
    }
    callback?.(reply);
  });

  vi.mocked(chrome.storage.local.get).mockImplementation((_keys: unknown, callback?: (items: unknown) => void) =>
    callback?.({ "filter_cache:easylist": { fetchedAt: Date.now() - 86_400_000 } }),
  );

  vi.mocked(chrome.tabs.query).mockImplementation((_query, callback) => callback([{ id: 5 } as chrome.tabs.Tab]));
}

beforeEach(() => {
  settings.value = { ...STORED_SETTINGS };
  note.value = null;
  query.value = "";
  document.documentElement.removeAttribute("data-theme");
  stubChrome();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settings", () => {
  it("reads the background's copy, which is what owns the defaults", async () => {
    await loadSettings();
    expect(sent[0]).toEqual({ type: "getSettings" });
    expect(settings.value.audioFormat).toBe("mp3");
  });

  it("persists through saveSettings so the background merges rather than replaces", async () => {
    await expect(saveSetting({ audioFormat: "flac" })).resolves.toBe(true);
    expect(sent[0]).toEqual({ type: "saveSettings", settings: { audioFormat: "flac" } });
  });

  it("sends only the field that changed", async () => {
    await saveSetting({ downloadFolder: "C:\\Videos" });
    expect(Object.keys(sent[0].settings as object)).toEqual(["downloadFolder"]);
  });

  it("offers exactly the audio containers the helper accepts", () => {
    expect([...AUDIO_FORMATS]).toEqual(["mp3", "m4a", "flac", "opus", "wav", "aac", "ogg"]);
  });

  it("never sends a key the background no longer reads", async () => {
    await saveSetting({ audioFormat: "mp3" });
    await setOverlayEnabled(true);
    await setSyncEnabled(true);

    const settingsPayloads = sent
      .filter((message) => message.type === "saveSettings")
      .map((message) => Object.keys(message.settings as object).join(","));
    expect(settingsPayloads.join(" ")).not.toMatch(/autoDownload/);
  });

  it("persists concurrency and the quality cap through saveSettings, one key each", async () => {
    await commit("maxConcurrentDownloads", { maxConcurrentDownloads: 5 }, "5 downloads at a time.");
    await commit("preferredMaxHeight", { preferredMaxHeight: 720 }, "Capped at 720p.");

    const saves = sent.filter((message) => message.type === "saveSettings");
    expect(saves).toEqual([
      { type: "saveSettings", settings: { maxConcurrentDownloads: 5 } },
      { type: "saveSettings", settings: { preferredMaxHeight: 720 } },
    ]);
    expect(settings.value.maxConcurrentDownloads).toBe(5);
    expect(settings.value.preferredMaxHeight).toBe(720);
    expect(note.value).toMatchObject({ field: "preferredMaxHeight", text: "Capped at 720p." });
  });

  it("reads an old profile's missing or out-of-range values as the contract's defaults", async () => {
    mockSendMessage((message, callback) => {
      sent.push(message as Record<string, unknown>);
      callback?.({ ok: true, settings: { maxConcurrentDownloads: 40, preferredMaxHeight: 999 } });
    });
    await loadSettings();
    expect(settings.value.maxConcurrentDownloads).toBe(6);
    expect(settings.value.preferredMaxHeight).toBe(0);

    mockSendMessage((_message, callback) => callback?.({ ok: true, settings: {} }));
    await loadSettings();
    expect(settings.value.maxConcurrentDownloads).toBe(3);
    expect(settings.value.minSizeBytes).toBeNull();
  });

  it("defaults an unrecognised or absent theme to system rather than trusting it", async () => {
    stubChrome();
    mockSendMessage((message, callback) => {
      sent.push(message as Record<string, unknown>);
      callback?.({ ok: true, settings: { ...STORED_SETTINGS, theme: "chartreuse" } });
    });

    await loadSettings();
    expect(settings.value.theme).toBe("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("theme (spec D6)", () => {
  it("applies light and dark to the live document and persists the choice", async () => {
    await setTheme("dark");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(sent[0]).toEqual({ type: "saveSettings", settings: { theme: "dark" } });
    expect(note.value).toMatchObject({ field: "theme", text: "dark appearance.", error: false });
  });

  it("represents system by removing the attribute, never by writing the string", async () => {
    await setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    await setTheme("system");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("puts the document back where the stored settings say when the write fails", async () => {
    await setTheme("light");
    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "storage full" }));

    await setTheme("dark");
    // The failed save must not leave the page in a state storage does not describe.
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(note.value).toMatchObject({ field: "theme", error: true });
  });

  it("confirms on the control that changed, not on one page-level line", async () => {
    await commit("audioFormat", { audioFormat: "flac" }, "Audio format saved.");
    expect(note.value).toMatchObject({ field: "audioFormat", text: "Audio format saved." });
  });

  it("surfaces a failed save as an error on that control and does not claim success", async () => {
    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "storage full" }));
    await expect(commit("minSizeBytes", { minSizeBytes: 1024 }, "Size filter saved.")).resolves.toBeUndefined();
    expect(note.value).toMatchObject({ field: "minSizeBytes", error: true, text: "storage full" });
  });

  it("fades a confirmation after 2s but keeps an error until it is replaced", async () => {
    vi.useFakeTimers();
    await commit("audioFormat", { audioFormat: "flac" }, "Audio format saved.");
    expect(note.value?.shown).toBe(true);

    vi.advanceTimersByTime(1999);
    expect(note.value?.shown).toBe(true);

    vi.advanceTimersByTime(1);
    expect(note.value?.shown).toBe(false);

    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "nope" }));
    await commit("audioFormat", { audioFormat: "wav" }, "Size filter saved.");
    vi.advanceTimersByTime(10_000);
    expect(note.value).toMatchObject({ field: "audioFormat", error: true, shown: true });
  });
});

describe("overlay", () => {
  it("saves, then pushes the new state at the open tab", async () => {
    await setOverlayEnabled(false);

    expect(sent[0]).toEqual({ type: "saveSettings", settings: { overlayEnabled: false } });
    expect(sent[1]).toEqual({ type: "getSettings" });
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls[0].slice(0, 2)).toEqual([
      5,
      { type: "setOverlayEnabled", enabled: false },
    ]);
    expect(note.value).toMatchObject({ field: "overlayEnabled", text: "Overlay hidden." });
  });

  it("does not push when the save failed", async () => {
    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "nope" }));
    await setOverlayEnabled(false);
    expect(vi.mocked(chrome.tabs.sendMessage)).not.toHaveBeenCalled();
  });
});

describe("history sync", () => {
  it("goes through the message that persists the flag itself", async () => {
    await setSyncEnabled(false);
    expect(sent[0]).toEqual({ type: "setDownloadSyncEnabled", enabled: false });
    expect(settings.value.downloadSyncEnabled).toBe(false);
  });

  it("clears synced history and re-reads the count", async () => {
    await clearHistory();
    expect(sent[0]).toEqual({ type: "clearDownloadSyncHistory" });
    expect(sent.filter((message) => message.type === "getDownloadSyncHistory")).toHaveLength(1);
    expect(historyCount.value).toBe(7);
    expect(note.value).toMatchObject({ field: "history", text: "Synced history cleared." });
  });
});

describe("helper diagnostics", () => {
  it("reads the cached status the background maintains", async () => {
    stubChrome({
      connected: true,
      version: "1.4.0",
      dependencies: { ytDlp: true, ffmpeg: false },
      lastChecked: 1,
    });
    await loadHelperStatus();

    expect(sent[0]).toEqual({ type: "getHelperStatus" });
    expect(helper.value.connected).toBe(true);
    expect(helper.value.version).toBe("1.4.0");
    expect(helper.value.dependencies.ffmpeg).toBe(false);
  });

  it("records the error when the helper does not answer", async () => {
    mockSendMessage((_message, callback) => callback?.({ ok: false, error: "no native host" }));
    await loadHelperStatus();
    expect(helper.value.connected).toBe(false);
    expect(helper.value.error).toBe("no native host");
  });
});

describe("filter list sources", () => {
  it("reports each fixed source with its cache age, and enables nothing", async () => {
    await loadFilterLists();

    expect(filterLists.value.map((list) => list.key)).toEqual([
      "ublock-filters",
      "unbreak",
      "resource-abuse",
      "privacy",
      "easylist",
      "easyprivacy",
    ]);
    expect(filterLists.value.find((list) => list.key === "easylist")?.fetchedAt).toBeGreaterThan(0);
    expect(filterLists.value.find((list) => list.key === "unbreak")?.fetchedAt).toBe(0);
    expect(sent).toEqual([]);
  });

  it("marks a never-fetched cache rather than throwing", async () => {
    vi.mocked(chrome.storage.local.get).mockImplementation((_keys: unknown, callback?: (items: unknown) => void) =>
      callback?.({}),
    );
    await loadFilterLists();
    expect(filterLists.value.every((list) => list.fetchedAt === 0)).toBe(true);
  });
});

describe("boot", () => {
  it("reads all four sources in one pass", async () => {
    await loadAll();
    const types = sent.map((message) => message.type);
    expect(types).toEqual(["getSettings", "getHelperStatus", "getDownloadSyncHistory"]);
  });

  it("names the storage.local key it mirrors", () => {
    expect(SETTINGS_STORAGE_KEY).toBe("qwinSettings");
  });
});
