import { animate } from "motion";
import { useEffect, useRef, useState } from "preact/hooks";

import { Button } from "../../ui/components/Button.js";
import { videoThumbnailCandidates, videoTitle } from "../../ui/format.js";
import { Icon } from "../../ui/Icon.js";
import { prefersReducedMotion, springs } from "../../ui/motion.js";
import { clear, selectedCount, selection } from "../../ui/useStickySelection.js";
import { AUDIO_FORMAT, currentVideos } from "../state/videos.js";

/**
 * §6.9's enter, verbatim: it "springs up from the bottom edge on first selection" on
 * `springs.thrown` (`bounce: 0.2` — the spec's damping 0.8), because "it was thrown,
 * not faded in". Bounce is earned here and nowhere else: a bar that merely faded would
 * not read as arriving from off-screen.
 *
 * Under `prefers-reduced-motion: reduce` this becomes a plain opacity crossfade with no
 * transform at all (§4.6) — the slide is the part that carries vestibular weight, and
 * §4.6 keeps opacity feedback because reduced motion is not no feedback.
 */
const ENTER = { transform: ["translateY(140%)", "translateY(0%)"], opacity: [0, 1] };
const EXIT = { transform: ["translateY(0%)", "translateY(140%)"], opacity: [1, 0] };

/**
 * Spec §6 (D1): the selection bar shows what is selected, so each selected row gets its
 * tile. At 24px a retry ladder is pointless — this is `videoThumbnailCandidates(video)[0]`
 * and the play/music glyph when that is empty, full stop.
 *
 * `currentVideos` rather than `displayedVideos`: a row the user selected and then
 * filtered out is still selected, and its art should not vanish because of a search
 * term. Read as a module signal, like every other input here — `useStickySelection` is
 * explicit that the selection is shared state rather than a prop, so adding a `videos`
 * prop would be the odd one out.
 *
 * ponytail: the strip clips rather than capping plus a "+N more". The count beside it
 * already says how many are selected, so a truncated strip loses no information — if
 * tiles ever need to be individually reachable, cap the slice and add the overflow chip.
 *
 * Clipping only works if the strip is *allowed* to shrink: it was `shrink-0`, so 40
 * selected tracks demanded ~1000px of flex basis in a 460px popup, `overflow-hidden`
 * clipped nothing because the box never got smaller than its content, and the count,
 * "Download all" and "Clear" were pushed off the right edge — which is what "there is no
 * Download all button" reported. `min-w-0 shrink` is the pair that makes the clip real:
 * `overflow-x-auto` zeroes the automatic minimum size, so the strip yields instead of
 * overflowing. The two buttons take `shrink-0` in return, or they squeeze instead.
 *
 * `overflow-x-auto` is also the swipe. A touch drag on an `overflow-x` box scrolls it
 * natively — momentum, trackpad, shift+wheel and keyboard all included — so there is no
 * pointer handler, no drag state and nothing to clean up. `grow` hands the strip the
 * leftover width instead of the count taking it, which is what gives a one-tile
 * selection a scrollable box to grow into; the count gives up `flex-1` so it cannot
 * squeeze the strip back to nothing. The scrollbar is suppressed because a 24px-tall
 * native scrollbar in a 28px bar reads as a defect, not as an affordance.
 */
function SelectedTiles() {
  const chosen = (currentVideos.value || []).filter((video) => selection.value.has(video.id));

  if (!chosen.length) {
    return null;
  }

  return (
    <span class="flex min-w-0 grow shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      {chosen.map((video) => {
        const art = videoThumbnailCandidates(video)[0];
        const audio = String(video.format || "").toUpperCase() === AUDIO_FORMAT;
        return (
          <span
            key={video.id}
            title={videoTitle(video)}
            class="relative size-6 shrink-0 overflow-hidden rounded-badge bg-raised"
          >
            {art ? (
              <img class="size-full object-cover" alt="" src={art} />
            ) : (
              <span
                aria-hidden="true"
                class={`absolute inset-0 flex items-center justify-center ${audio ? "text-purple" : "text-text-tertiary"}`}
              >
                <Icon name={audio ? "music.note" : "play"} size={12} />
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export interface SelectionBarProps {
  /** Batch executor: downloads the ordered selection via `downloadMany`. */
  onDownloadAll: () => void;
}

/**
 * The sticky multi-select bar (spec §6.9, D21).
 *
 * Translucent chrome, blur 20px, and **scrim-free** — §6.9's reason is apple-design
 * §12's: "a parallel, non-blocking layer must not break flow". A dimming scrim would
 * tell the user the list behind it is unavailable while they are still expected to keep
 * scanning it. So the bar floats over the list without touching it, and the list keeps
 * its scroll position underneath.
 *
 * `sticky bottom-0` rather than `position: fixed` or an absolutely-positioned sibling:
 * a fixed bar would need to know the popup body's height (which is Chrome's, not ours),
 * and an absolute one needs a positioned ancestor this component should not have to
 * know about. Sticky needs neither.
 */
export function SelectionBar({ onDownloadAll }: SelectionBarProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const count = selectedCount.value;
  const [mounted, setMounted] = useState(false);

  // The exit has to finish before the node leaves the tree; unmounting on `count === 0`
  // alone would give `animate()` nothing to animate and the bar would blink out instead
  // of being thrown away.
  useEffect(() => {
    if (count > 0) {
      setMounted(true);
      return;
    }
    const bar = barRef.current;
    if (!bar || prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const controls = animate(bar, EXIT, { ...springs.thrown, type: "spring" });
    controls.finished.then(
      () => setMounted(false),
      () => setMounted(false),
    );
    return () => controls.stop();
  }, [count]);

  useEffect(() => {
    if (count <= 0 || !mounted) {
      return;
    }
    const bar = barRef.current;
    if (!bar) {
      return;
    }
    if (prefersReducedMotion()) {
      bar.style.opacity = "1";
      bar.style.transform = "none";
      return;
    }
    // Animating `transform` rather than replaying a fixed keyframe pair is what lets an
    // interrupt mid-flight continue from what is on screen (§4.5): re-select while the
    // bar is still settling and it keeps its current position and velocity.
    const controls = animate(bar, ENTER, { ...springs.thrown, type: "spring" });
    // `stop()` rejects `finished` with an AbortError, and the cleanup below calls
    // `stop()` on every unmount and on every re-target — so without this line each
    // interrupted spring surfaces as an unhandled rejection. Nothing observes this
    // animation's outcome: the exit effect owns the state transition, not the promise.
    controls.finished.catch(() => undefined);
    return () => controls.stop();
  }, [count, mounted]);

  if (!mounted) {
    return null;
  }

  return (
    <div
      ref={barRef}
      // `role="status"` + `aria-live="polite"`: the count is the only thing here that
      // changes without a click, and a screen-reader user selecting by keyboard needs
      // to hear it.
      role="status"
      aria-live="polite"
      class="material-chrome sticky bottom-0 z-20 mx-2 mb-2 flex items-center gap-3 rounded-card px-3 py-2 text-text"
    >
      <SelectedTiles />

      <span class="nums text-body min-w-0 shrink truncate text-text-muted">{count} selected</span>

      <Button variant="primary" size="sm" class="shrink-0" onClick={onDownloadAll}>
        <Icon name="download" size={13} />
        Download all
      </Button>

      <Button variant="ghost" size="sm" class="shrink-0" onClick={clear}>
        <Icon name="xmark" size={13} />
        Clear
      </Button>
    </div>
  );
}
