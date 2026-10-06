import { animate } from "motion";
import { useEffect, useRef, useState } from "preact/hooks";

import { Checkbox } from "../../ui/components/Checkbox.js";
import { videoThumbnailCandidates } from "../../ui/format.js";
import { Icon } from "../../ui/Icon.js";
import { prefersReducedMotion, springs } from "../../ui/motion.js";
import {
  playlistSelectionState,
  setPlaylistChildrenSelected,
  isPlaylistExpanded,
  type PlaylistGroup,
} from "../state/playlists.js";

export interface PlaylistRowProps {
  row: PlaylistGroup;
  /** The listbox's active row. Same contract as `VideoRow`'s. */
  active: boolean;
  /** `useListKeys`'s `rowId(index)` — the only way `aria-activedescendant` resolves. */
  id?: string;
  onToggle(): void;
}

/**
 * The folder header a playlist collapses into: cover, name, track count, and the
 * disclosure chevron.
 *
 * ## The row is the control
 *
 * The click handler sits on the whole `<li>`, not on the chevron. A folder is the row's
 * primary meaning — it is most of what is on screen — so making the user find a 14px
 * glyph to open it is the wrong target size for the primary action. The one exception
 * is the checkbox, which stops propagation: selecting tracks and opening the folder are
 * different questions, and a click that answered both would be a bug the user could not
 * undo.
 *
 * ## The checkbox is a three-state control, and the middle state is not decoration
 *
 * `Checkbox` already renders `indeterminate` (it is the batch bar's "some but not all"),
 * so the folder's own box reuses it rather than inventing a second control. The state
 * comes from the shared selection set, never from a prop, so the folder's box and the
 * "N selected" count cannot disagree — the same reason `VideoRow` reads the set instead
 * of trusting its `selected` prop.
 *
 * ## One glyph, rotated
 *
 * `chevron.right` rotated 90° *is* `chevron.down`, so the spring animates a `rotate`
 * rather than swapping two glyphs: swapping would pop the shape at the halfway point,
 * and there is only ever one icon to keep in `ui/Icon.tsx` in sync. `springs.checkbox` is
 * the control-snap preset (`bounce: 0.3`, ~160ms) — §4.5's overshoot is for controls the
 * user just pressed, and this is one. Under `prefers-reduced-motion` the transform is
 * written directly instead, because §4.6 keeps the state change and drops the travel.
 *
 * ## No height animation
 *
 * The children mount instantly. Measuring a pixel height per folder to animate a reveal
 * would mean a second layout pass on a list that is not virtualized and can hold a
 * hundred rows; the chevron is the feedback, and it is enough.
 */
export function PlaylistRow({ row, active, id, onToggle }: PlaylistRowProps) {
  const chevronRef = useRef<HTMLSpanElement | null>(null);
  const [thumbIndex, setThumbIndex] = useState(0);

  // Read through the module so this row subscribes: `isPlaylistExpanded` touches
  // `expandedPlaylists.value`, which is what re-renders the chevron and `aria-expanded`.
  const expanded = isPlaylistExpanded(row.id);
  const chosen = playlistSelectionState(row.children);

  // The same ordered ladder `VideoRow` draws, built from the folder's cover plus the
  // site-derived guess for the playlist page — one shared helper rather than a second
  // copy of the ladder rules.
  const candidates = videoThumbnailCandidates({ thumbnailUrl: row.thumbnailUrl, pageUrl: row.id });
  const thumbnail = candidates[thumbIndex] || "";

  useEffect(() => {
    const chevron = chevronRef.current;
    if (!chevron) {
      return;
    }
    if (prefersReducedMotion()) {
      chevron.style.transform = expanded ? "rotate(90deg)" : "none";
      return;
    }
    // Animating the live `rotate` rather than replaying fixed keyframes is what lets an
    // interrupted fold continue from where it is on screen (§4.5).
    const controls = animate(chevron, { rotate: expanded ? 90 : 0 }, { ...springs.checkbox, type: "spring" });
    // `stop()` rejects `finished` with an AbortError and the cleanup calls it on every
    // unmount and re-fold, so nothing may observe the promise — see `SelectionBar`.
    controls.finished.catch(() => undefined);
    return () => controls.stop();
  }, [expanded]);

  return (
    <li
      id={id}
      role="option"
      aria-selected={chosen === "all"}
      aria-expanded={expanded}
      onClick={onToggle}
      class={`group flex cursor-pointer gap-3 rounded-row p-2 transition-colors ${active ? "bg-raised" : ""}`.trim()}
    >
      {/* `stopPropagation`, not a `preventDefault`: the checkbox's own `change` handler
          is what selects, and cancelling it would leave the input out of step. */}
      <span class="flex w-4 shrink-0 items-start justify-center pt-1" onClick={(event) => event.stopPropagation()}>
        <Checkbox
          checked={chosen === "all"}
          indeterminate={chosen === "some"}
          onChange={(checked) => setPlaylistChildrenSelected(row.children, checked)}
          ariaLabel={`Select all ${row.count} tracks in ${row.title}`}
        />
      </span>

      {/* 48px square, `rounded-badge` like every other tile in the app. The glyph is the
          honest state for "the host could not resolve a cover" — yt-dlp's flat
          enumeration does not always have one. */}
      <span class="relative size-12 shrink-0 overflow-hidden rounded-badge bg-raised">
        {thumbnail ? (
          <img
            class="size-full object-cover"
            alt=""
            loading="lazy"
            decoding="async"
            src={thumbnail}
            onError={() => thumbnail && setThumbIndex((index) => index + 1)}
          />
        ) : (
          <span aria-hidden="true" class="absolute inset-0 flex items-center justify-center text-purple">
            <Icon name="music.note" size={20} />
          </span>
        )}
      </span>

      <div class="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <p class="text-row line-clamp-2 min-w-0 text-text" title={row.title}>
          {row.title}
        </p>
        <p class="nums text-caption text-text-muted">{row.count === 1 ? "1 track" : `${row.count} tracks`}</p>
      </div>

      <span class="flex shrink-0 items-center text-text-tertiary">
        <span ref={chevronRef} class="flex items-center">
          <Icon name="chevron.right" size={16} />
        </span>
      </span>
    </li>
  );
}
