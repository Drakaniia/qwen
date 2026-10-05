/**
 * The three sections a user opens this page to *change*, plus the table that arranges
 * all five. The two read-mostly groups live in `diagnostics.tsx`.
 *
 * Order and grouping are by task, not by data source. Nothing here holds a palette, a
 * radius or a control height: every one of those is a `src/ui/` component or a
 * `theme.css` token, and a second copy is how this project ended up with three.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { AdvancedSection, HelperSection } from "./diagnostics.js";
import { Saved } from "./Saved.js";
import {
  AUDIO_FORMATS,
  chooseFolder,
  commit,
  helper,
  setOverlayEnabled,
  setSyncEnabled,
  settings,
  setTheme,
} from "./state.js";
import { StatusDot } from "../../ui/Icon.js";
import { Button } from "../../ui/components/Button.js";
import { Field } from "../../ui/components/Field.js";
import { Meter } from "../../ui/components/Meter.js";
import { Segmented } from "../../ui/components/Segmented.js";
import { Toggle } from "../../ui/components/Toggle.js";

// ─── Appearance ───────────────────────────────────────────────────────────────

/**
 * Live read of an OS media preference.
 *
 * Used only by the reduced-motion acknowledgement, which must report what is true now
 * rather than what was true when the page opened — a user who flips the OS setting
 * should not have to reload to see the row agree with them.
 */
function useMediaQuery(queryText: string): boolean {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(queryText).matches === true);
  useEffect(() => {
    const list = globalThis.matchMedia?.(queryText);
    if (!list) {
      return;
    }
    const onChange = () => setMatches(list.matches);
    list.addEventListener("change", onChange);
    setMatches(list.matches);
    return () => list.removeEventListener("change", onChange);
  }, [queryText]);
  return matches;
}

const THEME_SEGMENTS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function AppearanceSection() {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  return (
    <>
      <div class="flex flex-col gap-2">
        <span class="text-row text-text">Theme</span>
        <Segmented
          segments={THEME_SEGMENTS}
          value={settings.value.theme ?? "system"}
          onChange={(next) => void setTheme(next)}
          ariaLabel="Theme"
          class="max-w-72"
        />
        <Saved field="theme" />
        <p class="text-caption text-text-muted">
          System follows your operating system. The choice applies immediately and survives a restart.
        </p>
      </div>

      {/*
        Acknowledgement, not a control (spec §8). A second source of truth for reduced
        motion would fight the OS setting rather than complement it, so this row reports
        the preference and offers no toggle to contradict it.
      */}
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <StatusDot
            state={reducedMotion ? "caution" : "success"}
            label={reducedMotion ? "Reduced motion is on" : "Reduced motion is off"}
          />
          <span class="text-body text-text">Reduced motion</span>
        </div>
        <p class="text-caption text-text-muted">
          {reducedMotion
            ? "Your system asks for reduced motion, so animations are simplified."
            : "Follows your system setting. Animations play as designed."}
        </p>
      </div>
    </>
  );
}

// ─── Downloads ────────────────────────────────────────────────────────────────

/**
 * The folder path, committed on blur rather than on every keystroke.
 *
 * Uncontrolled on purpose: saving per keystroke would fire a message per character,
 * and re-rendering a controlled input from a signal that the save itself writes back
 * clobbers half-typed text. The DOM holds the draft; blur reads it once.
 */
function FolderField() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stored = settings.value.downloadFolder;

  // Adopt an externally-changed value (Browse, or a save that succeeded) without
  // clobbering a draft the user is still typing into.
  useEffect(() => {
    const input = inputRef.current;
    if (input && input.value !== stored) {
      input.value = stored;
    }
  }, [stored]);

  const commitFolder = () => {
    const next = (inputRef.current?.value || "").trim();
    if (next === stored) {
      return;
    }
    void commit("downloadFolder", { downloadFolder: next }, "Download folder saved.");
  };

  return (
    <Field label="Download folder" hint="A Windows path such as C:\Users\You\Downloads\Videos.">
      {({ id, describedBy }) => (
        <div class="flex items-center gap-2">
          <input
            ref={inputRef}
            id={id}
            aria-describedby={describedBy}
            type="text"
            spellcheck={false}
            placeholder="Default: Windows Downloads"
            defaultValue={stored}
            onBlur={commitFolder}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitFolder();
              }
            }}
            class="ring-focus h-[var(--control-height-md)] min-w-0 flex-1 rounded-input border border-border bg-surface px-3 text-body text-text"
          />
          <Button onClick={() => void chooseFolder()}>Browse...</Button>
        </div>
      )}
    </Field>
  );
}

function DownloadsSection() {
  const current = settings.value;

  return (
    <>
      <FolderField />
      <Saved field="downloadFolder" />

      <Field label="Audio format" hint="Used when a download is audio only.">
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy}
            value={current.audioFormat}
            onChange={(event) =>
              void commit("audioFormat", { audioFormat: event.currentTarget.value }, "Audio format saved.")
            }
            class="ring-focus h-[var(--control-height-md)] self-start rounded-input border border-border bg-surface px-3 text-body text-text"
          >
            {AUDIO_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Saved field="audioFormat" />

      <div class="flex flex-col gap-2">
        <span class="text-row text-text">Hide videos smaller than</span>
        <Meter
          value={current.minSizeBytes ?? null}
          onChange={(bytes) => void commit("minSizeBytes", { minSizeBytes: bytes }, "Size filter saved.")}
          ariaLabel="Minimum video size"
          class="max-w-72 self-start"
        />
        <Saved field="minSizeBytes" />
        <p class="text-caption text-text-muted">The starting value for the popup's size filter.</p>
      </div>

      <Toggle
        label="Download subtitles by default"
        hint="Turn off to leave subtitle tracks alone when a video has them."
        checked={current.downloadSubtitles !== false}
        onChange={(next) =>
          void commit(
            "downloadSubtitles",
            { downloadSubtitles: next },
            next ? "Subtitles on by default." : "Subtitles off by default.",
          )
        }
      />
      <Saved field="downloadSubtitles" />
    </>
  );
}

// ─── Page integration ─────────────────────────────────────────────────────────

function IntegrationSection() {
  const current = settings.value;

  return (
    <>
      <Toggle
        label="Show a download button on detected video players"
        hint="Off hides the overlay until you turn it back on here."
        checked={current.overlayEnabled}
        onChange={(next) => void setOverlayEnabled(next)}
      />
      <Saved field="overlayEnabled" />

      <Toggle
        label="Sync completed downloads across browsers"
        hint="History lives in your browser profile's sync area and is capped at 200 entries."
        checked={current.downloadSyncEnabled}
        onChange={(next) => void setSyncEnabled(next)}
      />
      <Saved field="downloadSyncEnabled" />
    </>
  );
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Section order is by task frequency, not by data source: what a user opens this page
 * to change is nearly always where files land or how the page looks, and the native
 * helper is a diagnostic you visit *after* something has already gone wrong.
 *
 * `status()` and `body()` are thunks rather than elements so the section list can read
 * each signal inside *its own* render, where it subscribes. Hoisting them would make
 * the dot and the body stale the moment the helper status changed.
 */
export const SECTIONS: readonly {
  title: string;
  terms: string;
  status(): ComponentChildren;
  body(): ComponentChildren;
}[] = [
  {
    title: "Downloads",
    terms: "folder path browse location audio format mp3 flac size filter minimum subtitles captions cc",
    status: () => null,
    body: () => <DownloadsSection />,
  },
  {
    title: "Appearance",
    terms: "theme system light dark colour color scheme motion animation reduced accessibility",
    status: () => null,
    body: () => <AppearanceSection />,
  },
  {
    title: "Page integration",
    terms: "overlay in-page button sync history browsers",
    status: () => null,
    body: () => <IntegrationSection />,
  },
  {
    title: "Native helper",
    terms: "connection connected version yt-dlp ffmpeg aria2c n_m3u8dl-re streamlink install recheck check again",
    status: () => {
      const status = helper.value;
      return (
        <StatusDot
          state={status.connected ? "success" : "critical"}
          label={status.connected ? "Native helper connected" : "Native helper not connected"}
        />
      );
    },
    body: () => <HelperSection />,
  },
  {
    title: "Advanced",
    terms: "filter lists sources cache ublock easylist privacy synced history clear",
    status: () => null,
    body: () => <AdvancedSection />,
  },
];
