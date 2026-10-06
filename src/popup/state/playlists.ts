/**
 * Playlist folders: the grouping the Media list renders, and nothing else.
 *
 * ## Why this lives outside every component
 *
 * A pasted playlist used to be 100 flat rows, and the only place that knew how to turn
 * those rows into one collapsible folder would have been `MediaView` — a component, and
 * therefore a DOM. The rule ("consecutive rows sharing a `playlistId` collapse into one
 * header, expanded ones add their children back") is pure algebra over a signal, so it
 * belongs in a signal module where a test can exercise it without mounting anything.
 * Same split as `ui/filter.ts` and `state/videos.ts`: the page owns the state, a module
 * owns the rules.
 *
 * ## `displayedVideos` is NOT changed
 *
 * Search, the facet dropdowns, the size meter and every sort keep operating on the
 * *songs*, not on the folders. That is deliberate: a search for one track has to be able
 * to find it inside a collapsed folder, and "40 of 40 detected" describes detection,
 * not rendering. Folding at render time only means the filter controls and the visible
 * rows can disagree about which candidates exist, which is exactly what they are for.
 *
 * ## Every write is a new reference
 *
 * Signals diff by identity, so `togglePlaylist` builds a fresh `Set` rather than mutating
 * one — see `ui/useStickySelection.ts` for the same rule on the selection itself.
 *
 * ## Module-level, not a hook
 *
 * `MediaView`, the folder header row and the keyboard model all need to read the same
 * expanded set, and none of them nests inside the others. One exported signal is how
 * `state/videos.ts` and `useStickySelection.ts` already solve the identical problem.
 *
 * ## Not persisted
 *
 * A folder re-collapses when the popup reopens. That is the intended behaviour: the
 * popup is a transient surface, and "which folders were open" is not a preference
 * anybody has asked to keep.
 */
import { computed, signal } from "@preact/signals";

import { select, selection } from "../../ui/useStickySelection.js";
import { displayedVideos, type VideoCandidate } from "./videos.js";

/** Which playlists are open. Read `expandedPlaylists.value` (or {@link isPlaylistExpanded}). */
export const expandedPlaylists = signal<ReadonlySet<string>>(new Set());

/** Open or close one folder. A fresh `Set` every write, so readers are woken. */
export function togglePlaylist(id: string): void {
  const next = new Set(expandedPlaylists.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedPlaylists.value = next;
}

/** Whether one folder is open. Reads `.value`, so a component using this subscribes. */
export function isPlaylistExpanded(id: string): boolean {
  return expandedPlaylists.value.has(id);
}

/** What the Media list renders: a folder header, a track, or a bare page candidate. */
export type MediaRow =
  | { kind: "video"; video: VideoCandidate }
  | {
      kind: "playlist";
      /** The `playlistId` shared by every child — the folder's identity and its key. */
      id: string;
      title: string;
      thumbnailUrl: string;
      /** How many tracks the folder holds, collapsed or not — the header's caption. */
      count: number;
      /** Always the full run, whether or not the folder is open: `Space` and the
       *  checkbox both select from it without needing the rows to be on screen. */
      children: VideoCandidate[];
    };

/** A folder row, named so `MediaView` and `PlaylistRow` need no cast. */
export type PlaylistGroup = Extract<MediaRow, { kind: "playlist" }>;

/**
 * `displayedVideos`, folded into rows.
 *
 * ONE pass, over the *sorted* list, grouping **consecutive** rows only. Not a `Map`
 * bucket pass: sorting is by the user's control and a search can split a playlist
 * across the page, so "consecutive runs" is what keeps two runs of the same playlist as
 * two folders instead of silently merging rows that are no longer adjacent. A group
 * takes the position its first member held, and an open group emits its header followed
 * by its children — so `rows.length` is the listbox's row count and `useListKeys`
 * navigates exactly what is on screen.
 */
export const mediaRows = computed<MediaRow[]>(() => {
  const rows: MediaRow[] = [];
  let open: PlaylistGroup | null = null;

  for (const video of displayedVideos.value) {
    const id = String(video.playlistId || "");
    if (!id) {
      // A bare candidate ends any run: the next playlist row starts a fresh folder.
      open = null;
      rows.push({ kind: "video", video });
      continue;
    }
    if (!open || open.id !== id) {
      open = {
        kind: "playlist",
        id,
        // First member wins for both strings: every row of one enumeration is stamped
        // identically, and a later host reply cannot make a title half-known.
        title: String(video.playlistTitle || "") || "Playlist",
        thumbnailUrl: String(video.playlistThumbnailUrl || ""),
        count: 0,
        children: [],
      };
      rows.push(open);
    }
    open.count += 1;
    open.children.push(video);
  }

  return rows.flatMap((row) =>
    row.kind === "video" ? [row] : [row, ...(expandedPlaylists.value.has(row.id) ? row.children.map(asVideoRow) : [])],
  );
});

function asVideoRow(video: VideoCandidate): MediaRow {
  return { kind: "video", video };
}

/**
 * Select or clear every track in a folder.
 *
 * `false` has to *subtract* rather than replace: a page candidate selected beside the
 * folder is still selected, and "clear this folder" must not silently clear it too.
 */
export function setPlaylistChildrenSelected(children: readonly VideoCandidate[], selected: boolean): void {
  const ids = new Set(children.map((child) => child.id));
  if (selected) {
    select(ids);
    return;
  }
  const kept = new Set([...selection.value].filter((id) => !ids.has(id)));
  selection.value = kept;
}

/**
 * Whether a folder's checkbox reads checked, unchecked, or `indeterminate`.
 *
 * A folder with no children cannot be "all selected" — an all-checked box on nothing
 * would claim a selection that does not exist, which is the one state a batch checkbox
 * must never show.
 */
export function playlistSelectionState(children: readonly VideoCandidate[]): "all" | "some" | "none" {
  if (!children.length) {
    return "none";
  }
  let chosen = 0;
  for (const child of children) {
    if (selection.value.has(child.id)) {
      chosen += 1;
    }
  }
  if (chosen === children.length) {
    return "all";
  }
  return chosen > 0 ? "some" : "none";
}
