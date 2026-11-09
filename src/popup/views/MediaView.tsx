import type { HTMLAttributes, Ref } from "preact";

import { EmptyState } from "../../ui/components/EmptyState.js";
import { FilterBar } from "../../ui/components/FilterBar.js";
import { Meter } from "../../ui/components/Meter.js";
import { SkeletonRow } from "../../ui/components/Skeleton.js";
import { patchFilter } from "../../ui/filter.js";
import { useListKeys } from "../../ui/useListKeys.js";
import { focusPasteBox, PasteBox } from "../components/PasteBox.js";
import { isSelected, notice, toggle } from "../state/app.js";
import {
  mediaRows,
  playlistSelectionState,
  setPlaylistChildrenSelected,
  togglePlaylist,
  type MediaRow,
} from "../state/playlists.js";
import {
  currentVideos,
  filterSummary,
  hasCandidates,
  scanStatus,
  sizeThreshold,
  videoFilter,
  videoFormatFacet,
  videoSourceFacet,
  type VideoCandidate,
} from "../state/videos.js";
import { rescanActiveTab } from "../popup_helpers.js";
import { startVideoDownload } from "../popup_actions.js";
import { PlaylistRow } from "./PlaylistRow.js";
import { VideoRow } from "./VideoRow.js";

const SELECT_CLASS =
  "h-7 cursor-pointer rounded-row border border-border bg-surface px-2 text-caption text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The Media view (spec §6.5–§6.7, §6.10, §10, D7, D8).
 *
 * This is the popup's one genuine multi-select list, so it is the one that gets §10's
 * keyboard model and `useListKeys`: `role="listbox"` + `aria-multiselectable` +
 * `aria-activedescendant`, with `↑` `↓` `Home` `End` moving the active row, `Enter`
 * downloading it and `Space` toggling it. `DownloadsView` deliberately does not — a job
 * row's own buttons have to stay in the tab order, and a roving tabindex would hide them.
 */
export function MediaView({ searchRef }: { searchRef: Ref<HTMLInputElement> }) {
  return (
    <>
      <PasteBox />

      {/* The one case where the banner is a duplicate: `MediaBody` is about to render
          "No video on this page" in the same words, one screen lower. Every other notice
          — no active tab, a failed clear, a copy failure — carries information the
          empty state does not, so it still renders. */}
      {notice.value.text && !scannedNothing() ? (
        <p
          role="status"
          aria-live="polite"
          class={`border-b border-separator px-4 py-2 text-caption ${
            notice.value.isError ? "text-critical" : "text-text-muted"
          }`}
        >
          {notice.value.text}
        </p>
      ) : null}

      <MediaBody searchRef={searchRef} />
    </>
  );
}

/**
 * Scanned, and nothing came back — spec §6.10's first designed state.
 *
 * One predicate for two callers: `MediaView` needs it to decide whether the `notice`
 * line is redundant, `MediaBody` needs it to choose the empty state. They can never
 * disagree, because both read the same two signals in the same render.
 */
function scannedNothing() {
  return scanStatus.value === "ready" && !(currentVideos.value || []).length;
}

function MediaBody({ searchRef }: { searchRef: Ref<HTMLInputElement> }) {
  const scan = scanStatus.value;

  // Still scanning: skeletons, not a sentence. §6.10 — "No state ships as a bare
  // centered sentence", and `animate-pulse` collapses to a static tint under
  // `prefers-reduced-motion` for free (see `ui/components/Skeleton.tsx`).
  if (scan === "pending" || scan === "scanning") {
    return (
      <div aria-label="Scanning this page" aria-busy="true">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  // Scan failed: §6.10's second designed state, with the real retry.
  if (scan === "failed") {
    return (
      <EmptyState
        icon="exclamationmark.triangle"
        tone="caution"
        headline="Couldn't read this page"
        body="Qwin could not ask the browser what this tab found. It usually clears on a rescan."
        action={{ label: "Retry scan", onClick: () => void rescanActiveTab() }}
      />
    );
  }

  // Scanned, nothing found: §6.10's first designed state. The action focuses the paste
  // box, which is the point — a page with no video is exactly the page where a link is
  // the way forward.
  if (scannedNothing()) {
    return (
      <EmptyState
        icon="film"
        headline="No video on this page"
        body="Nothing downloadable was detected here. A link works too."
        action={{ label: "Try a link instead", onClick: focusPasteBox }}
      />
    );
  }

  return (
    <>
      {/* A search box over a list that is already empty is noise, so the whole filter
          cluster hangs off `hasCandidates` rather than off the scan. */}
      {hasCandidates.value ? <FilterCluster searchRef={searchRef} /> : null}

      <MediaList />
    </>
  );
}

/**
 * The listbox itself.
 *
 * `useListKeys` owns the whole of §10's key model, so this is mostly plumbing: the two
 * callbacks it needs are closures over the same `mediaRows` array the rows render from,
 * so the index it reports is the index on screen. `idFor` is what makes
 * `aria-activedescendant` resolve — without it the hook would name `qwin-list-row-<n>`
 * and no element would carry that id.
 *
 * ## Playlist folders, in one flat listbox
 *
 * `mediaRows` (`state/playlists.ts`) has already folded each playlist's songs into one
 * `{kind:"playlist"}` header, so this component's whole job is to branch on `row.kind`:
 * a track downloads on `Enter`, a folder *opens* on `Enter`. A folder has no download
 * button of its own — `Download all` in the sticky bar is the batch path, and a folder
 * that downloaded itself would be a second answer to the same question.
 *
 * The children stay siblings in the one `<ul role="listbox">`. The obvious alternative —
 * a nested `<ul role="group">` under the header — is what §10's `aria-activedescendant`
 * cannot survive: the active row has to be owned by the element carrying the composite
 * role, so rows inside a nested list are not reachable by arrow keys. So the indentation
 * and its hairline come from a presentational wrapper around the run of `<li>`s instead,
 * which keeps every row a direct-ish descendant the hook can still name.
 */
function MediaList() {
  const rows = mediaRows.value;
  const keys = useListKeys({
    count: rows.length,
    // `Enter`: a track downloads through the same flow its own button runs, so there is
    // one download path; a folder opens.
    onDownload: (index) => {
      const row = rows[index];
      if (!row) {
        return;
      }
      if (row.kind === "playlist") {
        togglePlaylist(row.id);
        return;
      }
      if (row.video.downloadable) {
        void startVideoDownload(row.video.id);
      }
    },
    // `Space`: §6.9's selection is module state, so this is one call. On a folder it is
    // the whole track list, and the checkbox on the header answers the same question.
    onToggleSelect: (index) => {
      const row = rows[index];
      if (!row) {
        return;
      }
      if (row.kind === "playlist") {
        setPlaylistChildrenSelected(row.children, playlistSelectionState(row.children) !== "all");
        return;
      }
      toggle(row.video.id);
    },
    idFor: (index) => {
      const row = rows[index];
      // A folder is named by its position, not by its `playlistId` — the id is a URL, and
      // `aria-activedescendant` needs a token, not a query string.
      return row?.kind === "playlist" ? `qwin-media-folder-${index}` : `qwin-media-${row?.video.id || index}`;
    },
  });

  return (
    <ul
      // The hook types its props against `HTMLElement` because it has no opinion about
      // the element. The only structural difference is `ref`, and this list never gets
      // one, so the spread is safe here and nowhere else.
      {...(keys.containerProps as HTMLAttributes<HTMLUListElement>)}
      aria-label="Detected media"
      class="flex flex-col gap-2 p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {renderBlocks(rows).map((block) => {
        if (block.kind === "children") {
          return (
            <div
              key={`folder-${block.id}`}
              // `role="presentation"` says this div is not a widget of its own — its
              // children still are. `border-l` is the folder's rail; `pl-3` is the
              // indent. Both on the wrapper rather than on each `<li>` because
              // `VideoRow` renders its own row element and takes no class.
              role="presentation"
              class="flex flex-col gap-2 border-l border-separator pl-3"
            >
              {block.entries.map(({ index, video }) => (
                <VideoRow
                  key={video.id}
                  video={video}
                  active={index === keys.activeIndex}
                  selected={isSelected(video.id)}
                  id={keys.rowId(index)}
                  // A folder's track keeps its own Download button even while the
                  // paste's pre-selection is active — see the `bulk` note in `VideoRow`.
                  inFolder
                />
              ))}
            </div>
          );
        }
        const row = rows[block.index];
        if (row.kind === "playlist") {
          return (
            <PlaylistRow
              key={row.id}
              row={row}
              active={block.index === keys.activeIndex}
              id={keys.rowId(block.index)}
              onToggle={() => togglePlaylist(row.id)}
            />
          );
        }
        return (
          <VideoRow
            key={row.video.id}
            video={row.video}
            active={block.index === keys.activeIndex}
            selected={isSelected(row.video.id)}
            id={keys.rowId(block.index)}
          />
        );
      })}
    </ul>
  );
}

/**
 * `mediaRows` back into render blocks.
 *
 * A folder's children are flat rows with no parent marker, so the one thing this has to
 * recover is "which run of rows belongs to which open folder" — enough to emit them as
 * one indented block instead of N separately-indented rows with a broken rail between
 * each. Membership is read off `PlaylistGroup.children` rather than assumed from
 * adjacency, because a sorted list can interleave a page candidate between two tracks.
 */
type RenderBlock =
  | { kind: "row"; index: number }
  | { kind: "children"; id: string; entries: { index: number; video: VideoCandidate }[] };

function renderBlocks(rows: MediaRow[]): RenderBlock[] {
  const owner = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "playlist") {
      for (const child of row.children) {
        owner.set(child.id, row.id);
      }
    }
  }

  const blocks: RenderBlock[] = [];
  for (const [index, row] of rows.entries()) {
    const last = blocks[blocks.length - 1];
    if (row.kind !== "video") {
      blocks.push({ kind: "row", index });
      continue;
    }
    const folder = owner.get(row.video.id);
    if (folder && last && last.kind === "children" && last.id === folder) {
      last.entries.push({ index, video: row.video });
      continue;
    }
    blocks.push(
      folder ? { kind: "children", id: folder, entries: [{ index, video: row.video }] } : { kind: "row", index },
    );
  }
  return blocks;
}

/**
 * The filter cluster (spec §6.7): search + facets + the size meter, and the live
 * consequence line.
 *
 * §6.7, verbatim: "telling the user what the filter did is the difference between a
 * filter and a mystery." The line is not optional and it is not a status message — it
 * is a caption that changes as the controls change, and it says both halves: what is
 * shown and what the threshold hid.
 */
function FilterCluster({ searchRef }: { searchRef: Ref<HTMLInputElement> }) {
  const state = videoFilter.value;
  const summary = filterSummary.value;

  return (
    <div class="flex flex-col gap-2 border-b border-separator px-4 py-3">
      <FilterBar
        filter={state}
        onChange={(next) => (videoFilter.value = next)}
        searchLabel="Search detected media"
        searchRef={searchRef}
      >
        <select
          aria-label="All formats"
          value={state.format}
          onChange={(event) => (videoFilter.value = patchFilter(state, { format: event.currentTarget.value }))}
          class={SELECT_CLASS}
        >
          <option value="">All formats</option>
          {videoFormatFacet.value.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <select
          aria-label="All sources"
          value={state.source}
          onChange={(event) => (videoFilter.value = patchFilter(state, { source: event.currentTarget.value }))}
          class={SELECT_CLASS}
        >
          <option value="">All sources</option>
          {videoSourceFacet.value.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </FilterBar>

      <Meter ariaLabel="Minimum size" value={sizeThreshold.value} onChange={(bytes) => (sizeThreshold.value = bytes)} />

      {summary ? (
        <p class="text-caption text-text-muted" role="status" aria-live="polite">
          {summary}
        </p>
      ) : null}
    </div>
  );
}
