import { animate } from "motion";
import type { TargetedKeyboardEvent } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef } from "preact/hooks";

import { crossfade, prefersReducedMotion, springs } from "../motion.js";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Count on the Downloads segment while jobs are active (spec §6.4). */
  badge?: string | number;
}

export interface SegmentedProps<T extends string> {
  segments: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  /** Required: the group has no visible label of its own, so this is its only name. */
  ariaLabel: string;
  size?: "sm" | "md";
  class?: string;
}

/**
 * A value selector with a sliding indicator (spec §5.2): the theme control, the
 * Media/Downloads view switch and the batch bar.
 *
 * `role="radiogroup"` rather than `tablist`/`tab`, even though the view switch does
 * swap a panel. A tab's contract is that it controls a *tabpanel* the user can reach
 * with arrow keys, and two of the three uses here have no panel at all — the theme
 * control has none, and the batch bar is a set of chosen values. `radiogroup` is the
 * honest mapping for "exactly one of these", and it carries the same arrow-key
 * expectation without the panel bookkeeping.
 *
 * The indicator is a single element moved by transform rather than one indicator per
 * segment: re-targeting mid-flight reads the live `x` and springs from there, which is
 * what interruptibility means here (spec §4.5).
 */
export function Segmented<T extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
  size = "md",
  class: className,
}: SegmentedProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);
  // The in-flight indicator spring, so a *layout* change can stop it before writing the
  // new position (see `place`). Null when nothing is animating.
  const controlsRef = useRef<{ stop(): void } | null>(null);
  // Distinguishes the first placement (a layout) from every later selection (a move).
  const placedRef = useRef(false);
  const fadeMs = Math.round(crossfade.duration * 1000);
  // Callers pass the segment list inline, so the array identity changes every render.
  // The shape is what the measurement depends on, not the array.
  const shape = segments.map((segment) => segment.value).join("|");

  /**
   * Put the bar on the active segment.
   *
   * `animateMove` separates the two reasons this runs. A *selection change* is the one
   * movement the user asked for, so it springs. A *layout change* — first paint, the
   * stored width arriving from `getSettings`, a grip drag, a font swap — is not a state
   * change at all, so it is an instant write: no easing to fight the pointer (spec §4.5),
   * and no pill sliding in from the origin before the popup has been sized.
   */
  const place = useCallback((animateMove: boolean) => {
    const track = trackRef.current;
    const bar = barRef.current;
    const active = track?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (!track || !bar || !active) {
      return;
    }
    // `active.offsetLeft` is already track-relative: the track is the offsetParent.
    const x = active.offsetLeft;

    // Width is *written*, never animated. This was the real cost of the indicator.
    // `width` is not an accelerated value, so including it dropped the whole animation
    // off WAAPI onto motion's main-thread JS driver, where every frame wrote
    // `style.width` and forced a layout of the whole popup subtree — ~11 frames of
    // main-thread layout + paint over the switch, which reads as lag. The segments are
    // `flex-1`, so for the view control every one of them is already the same width and
    // the animation was interpolating a constant. One write covers the mount case too:
    // the bar arrives at its real width instead of growing from zero.
    bar.style.width = `${active.offsetWidth}px`;

    // Retarget, never queue: stopping mid-flight leaves the bar at its live position and
    // the next `animate()` reads that as its initial keyframe, so rapid clicks continue
    // from where the pill looks like it is. A layout change stops it outright and snaps.
    controlsRef.current?.stop();
    controlsRef.current = null;

    if (!animateMove || prefersReducedMotion()) {
      bar.style.transform = `translateX(${x}px)`;
      return;
    }
    // `springs.checkbox`, not `springs.material`: `material` is the dialog preset, and a
    // critically damped spring has a sluggish start — most of its travel is still ahead of
    // it a third of the way in, which reads as lag on a 130px pill. Measured through
    // `animate()` in Chromium, `checkbox` reaches 90% of the travel at ~60ms and settles
    // at ~160ms, with ~4% overshoot that lands as a snap. Only `x` animates, which is an
    // accelerated value, so it runs on the compositor. (Its `duration` is seconds — see
    // `motion.ts`: the old millisecond literal made every preset a ten-second spring.)
    controlsRef.current = animate(bar, { x }, { ...springs.checkbox, type: "spring" });
  }, []);

  // `useLayoutEffect`, not `useEffect`: Preact flushes effects *after* paint, so a
  // post-paint effect reads `offsetLeft` (forcing a second layout, after the expensive
  // view commit) and then starts the animation a frame or two late. On a Media/Downloads
  // switch the same commit tears down one list and mounts the other, so the pill did not
  // visibly start moving until that work was done — the "sluggish and delayed" symptom.
  // Before paint, one forced layout is unavoidable and sufficient: the position lands in
  // the same frame as the click. The first run is a placement, not a move, so the pill is
  // already sitting on the active segment on the popup's first frame.
  useLayoutEffect(() => {
    place(placedRef.current);
    placedRef.current = true;
  }, [value, shape, size, place]);

  // The popup's width is not known at first paint: `useResize` reads it back from
  // `getSettings` asynchronously, and the grip rewrites `document.body.style.width` on
  // every frame of a drag. Neither changes `value`, so without this the indicator kept its
  // first, pre-width measurement — a narrow, left-anchored pill on first open. A
  // `ResizeObserver` is the one hook that fires for all of them (and for a font swap); it
  // re-places instantly, because none of them is a state change.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => place(false));
    observer.observe(track);
    return () => observer.disconnect();
  }, [place]);

  // An unmount mid-flight must not leave a compositor animation running.
  useEffect(() => () => controlsRef.current?.stop(), []);

  const onKeyDown = (event: TargetedKeyboardEvent<HTMLDivElement>) => {
    const last = segments.length - 1;
    const index = Math.max(
      0,
      segments.findIndex((segment) => segment.value === value),
    );
    let next: number;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index >= last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index <= 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }

    const target = segments[next];
    if (!target) {
      return;
    }
    // Moving focus with the selection, not after it: a radiogroup whose arrow key
    // moves the caret without changing the value is a listbox, which is not what this is.
    event.preventDefault();
    onChange(target.value);
    trackRef.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      class={`relative isolate flex rounded-row bg-raised p-1 ${size === "sm" ? "h-8" : "h-9"} ${className || ""}`.trim()}
    >
      <span
        ref={barRef}
        aria-hidden="true"
        // No opacity gate. It used to be hidden until the first measurement so the bar
        // could not flash at the origin — but the layout effect above positions the bar
        // *before* the first paint, so there is no origin frame to hide, and the state
        // that toggled it only bought a second render plus a dead `transition-opacity`.
        class="pointer-events-none absolute inset-y-1 left-0 rounded-row bg-surface shadow-sm"
      />
      {segments.map((segment) => {
        const active = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: the group is one tab stop, arrows move inside it.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(segment.value)}
            class={`relative flex-1 rounded-row whitespace-nowrap transition-colors ${
              size === "sm" ? "h-6 px-2 text-caption" : "h-7 px-3 text-body"
            } ${active ? "text-text" : "text-text-muted hover:text-text"}`.trim()}
            style={{ transitionDuration: `${fadeMs}ms` }}
          >
            {segment.label}
            {segment.badge === undefined ? null : (
              <span class="nums ml-1 rounded-badge bg-accent px-1 text-accent-fg">{segment.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
