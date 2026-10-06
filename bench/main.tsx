/**
 * The Media list's measurement harness — **not part of the extension build**.
 *
 * It mounts the REAL `MediaView`: the same components, the same Tailwind build, the same
 * signal modules, inside the popup's own frame (460×560, with `PopupFrame`'s scrolling
 * `<main>`). The cost being asked about is DOM construction, style and layout — happy-dom
 * cannot show any of the three, so `tests/js/` is the wrong instrument for it.
 *
 * Thumbnails are 1×1 `data:` URLs: every row still builds its `<img>`, and nothing depends
 * on the network. Each track is shaped exactly like a row of a YouTube Music playlist
 * enumeration (`playlist_helpers.ts`): one `watch?v=` URL each, all sharing the playlist's
 * `playlistId` and `pageUrl`.
 *
 * Usage — see the note in `AGENTS.md` ("The media list is not virtualized"):
 *
 *   npx vite --config bench/vite.config.ts
 *   # then, in the page console:  await qwinBench.run(500)
 */
import { render } from "preact";
import { useRef } from "preact/hooks";

import "../src/ui/theme.css";
import { MediaView } from "../src/popup/views/MediaView.js";
import { expandedPlaylists, togglePlaylist } from "../src/popup/state/playlists.js";
import { currentVideos, setScanStatus, type VideoCandidate } from "../src/popup/state/videos.js";
import { selection } from "../src/ui/useStickySelection.js";

const PLAYLIST = "https://music.youtube.com/playlist?list=PLY5CT0TRwHPtTjWMe2NypsJ5MNRYquGs8";
/** A 1×1 GIF — renderable by `ui/format.ts` and resolvable without a request. */
const THUMB = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function track(index: number): VideoCandidate {
  return {
    id: `h${index}`,
    url: `https://www.youtube.com/watch?v=v${index}`,
    title: `Track ${index}`,
    pageUrl: PLAYLIST,
    source: "playlist",
    format: "YOUTUBE",
    playlistId: PLAYLIST,
    playlistTitle: "High School Radio",
    playlistThumbnailUrl: THUMB,
    thumbnailUrl: THUMB,
    downloadable: true,
    duration: 200 + (index % 60),
    // Newest first, so the run is one consecutive block and folds into one folder.
    lastSeen: 10_000 - index,
  };
}

function Bench() {
  const searchRef = useRef<HTMLInputElement>(null);

  return (
    // `PopupFrame`'s geometry: 460px is the default `popupWidth` (`ui/useResize.ts`) and
    // ~560px is the popup's own height cap. The `<main>` is the scrolling box the real
    // list lives in, copied class-for-class.
    <div style={{ width: "460px", height: "560px", display: "flex", flexDirection: "column" }}>
      <main class="material-content flex min-h-0 flex-1 flex-col overflow-y-auto">
        <MediaView searchRef={searchRef} />
      </main>
    </div>
  );
}

const host = document.getElementById("root") as HTMLElement;

/**
 * Resolves as soon as the container's DOM changes — a microtask after the mutation.
 *
 * Bounded, so a signal write that paints nothing fails the run instead of hanging it: a
 * benchmark that cannot tell "fast" from "never happened" is worse than no benchmark.
 */
function nextMutation(container: Element, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    // `attributes` matters as much as `childList`: the paste's pre-selection only flips
    // `aria-selected` and the checkbox property, and none of that is a node insertion.
    observer.observe(container, { childList: true, subtree: true, attributes: true, characterData: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`${label}: no DOM change within 3000ms`));
    }, 3000);
  });
}

/**
 * Force style + layout and report the synchronous part.
 *
 * `offsetHeight` alone only lays out this box; `scrollHeight` is what makes the browser
 * lay out all of the overflow content, which is the expensive half with 500 rows in it.
 */
function forceLayout(main: HTMLElement): number {
  const started = performance.now();
  void main.offsetHeight;
  void main.scrollHeight;
  return performance.now() - started;
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function heapMb(): number {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? Math.round(memory.usedJSHeapSize / 1048576) : 0;
}

export interface BenchReport {
  count: number;
  /** Collapsed mount: the folder header alone. */
  mountMs: number;
  mountLayoutMs: number;
  /** The signal write → the expanded DOM, then its layout. */
  expandMs: number;
  expandLayoutMs: number;
  expandScrollHeight: number;
  /** The paste's own pre-selection, which re-renders every row. */
  selectMs: number;
  rows: number;
  elements: number;
  images: number;
  frames: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameMaxMs: number;
  heapMb: number;
}

/** One cold mount → expand → pre-select, with no scroll probe. */
async function measureOnce(count: number) {
  // Fresh state on every run: these are module-level signals, and a remount does not reset
  // them.
  expandedPlaylists.value = new Set();
  selection.value = new Set();
  setScanStatus("ready");
  currentVideos.value = Array.from({ length: count }, (_value, index) => track(index));

  // A FRESH container per run: `host.innerHTML = ""` leaves Preact's own tree pointing at
  // nodes that are gone, and the next `render()` then diffs against a detached tree and
  // paints nothing.
  host.replaceChildren();
  const container = document.createElement("div");
  host.appendChild(container);

  // 1. Collapsed: one folder header, so this is the paste's first paint.
  const mountStart = performance.now();
  render(<Bench />, container);
  const mountMs = performance.now() - mountStart;
  const main = container.querySelector("main") as HTMLElement;
  const mountLayoutMs = forceLayout(main);

  // 2. Expanding the folder — the gesture the report was about.
  let mutated = nextMutation(container, "expand");
  const expandStart = performance.now();
  togglePlaylist(PLAYLIST);
  await mutated;
  const expandMs = performance.now() - expandStart;
  const expandLayoutMs = forceLayout(main);
  const expandScrollHeight = main.scrollHeight;

  // 3. The pre-selection a paste applies to its own rows.
  mutated = nextMutation(container, "select");
  const selectStart = performance.now();
  selection.value = new Set(Array.from({ length: count }, (_value, index) => `h${index}`));
  await mutated;
  const selectMs = performance.now() - selectStart;

  return {
    container,
    main,
    mountMs,
    mountLayoutMs,
    expandMs,
    expandLayoutMs,
    expandScrollHeight,
    selectMs,
  };
}

/** The median of a sample, and the spread — one sample of this operation says very little. */
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Repeat the cold path `reps` times and report the median and the spread.
 *
 * The spread is the point: the same expansion measured 69 ms and 263 ms on consecutive
 * runs, which is GC and lazy image decode landing wherever they land. A single number
 * would be a coin flip presented as a result.
 */
async function samples(count: number, reps = 5) {
  const expandMs: number[] = [];
  const selectMs: number[] = [];
  const layoutMs: number[] = [];
  let elements = 0;
  let images = 0;
  let rows = 0;

  for (let rep = 0; rep < reps; rep += 1) {
    const measured = await measureOnce(count);
    expandMs.push(round(measured.expandMs));
    selectMs.push(round(measured.selectMs));
    layoutMs.push(round(measured.expandLayoutMs));
    elements = measured.container.querySelectorAll("*").length;
    images = measured.container.querySelectorAll("img").length;
    rows = measured.container.querySelectorAll("li[role=option]").length;
  }

  return {
    count,
    reps,
    rows,
    elements,
    images,
    expandMs,
    expandMedianMs: median(expandMs),
    selectMs,
    selectMedianMs: median(selectMs),
    layoutMs,
    layoutMedianMs: median(layoutMs),
    heapMb: heapMb(),
  };
}

async function run(count: number): Promise<BenchReport> {
  const measured = await measureOnce(count);
  const { container, main, mountMs, mountLayoutMs, expandMs, expandLayoutMs, expandScrollHeight, selectMs } = measured;

  // 4. One pass down the list, frame by frame — the quantised feel of a long list.
  //    Forty steps, so the frame count does not collapse as the list grows: the probe is
  //    after the *distribution*, and six frames cannot say anything about a p95.
  const frames: number[] = [];
  const step = Math.max(200, Math.ceil(main.scrollHeight / 40));
  let previous = await frame();
  const scrollStart = performance.now();
  while (performance.now() - scrollStart < 4000) {
    main.scrollTop += step;
    const now = await frame();
    frames.push(now - previous);
    previous = now;
    if (main.scrollTop + main.clientHeight >= main.scrollHeight) {
      break;
    }
  }
  const sorted = [...frames].sort((left, right) => left - right);
  const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;

  return {
    count,
    mountMs: round(mountMs),
    mountLayoutMs: round(mountLayoutMs),
    expandMs: round(expandMs),
    expandLayoutMs: round(expandLayoutMs),
    expandScrollHeight,
    selectMs: round(selectMs),
    rows: container.querySelectorAll("li[role=option]").length,
    elements: container.querySelectorAll("*").length,
    images: container.querySelectorAll("img").length,
    frames: frames.length,
    frameP50Ms: round(percentile(0.5)),
    frameP95Ms: round(percentile(0.95)),
    frameMaxMs: round(sorted[sorted.length - 1] || 0),
    heapMb: heapMb(),
  };
}

/** Step-by-step diagnostics for the harness itself, not a measurement. */
async function probe(count: number) {
  expandedPlaylists.value = new Set();
  selection.value = new Set();
  setScanStatus("ready");
  currentVideos.value = Array.from({ length: count }, (_value, index) => track(index));
  host.replaceChildren();
  const container = document.createElement("div");
  host.appendChild(container);
  render(<Bench />, container);
  const collapsed = container.querySelectorAll("li[role=option]").length;
  togglePlaylist(PLAYLIST);
  await new Promise((resolve) => setTimeout(resolve, 80));
  return {
    count,
    hasMain: Boolean(container.querySelector("main")),
    collapsed,
    expanded: container.querySelectorAll("li[role=option]").length,
    html: container.innerHTML.slice(0, 160),
  };
}

/** The page's only entry point. `await qwinBench.samples(500)`. */
(globalThis as unknown as { qwinBench: { run: typeof run; samples: typeof samples; probe: typeof probe } }).qwinBench =
  { run, samples, probe };
