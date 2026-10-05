/**
 * The house motion vocabulary (spec §4.5).
 *
 * Every animated surface in the popup takes its numbers from here. §4.5 is a table of
 * house rules precisely so that no view invents its own duration and damping again —
 * four springs, one tween, and one rubber-band function is the whole vocabulary.
 *
 * **Interruptibility is a requirement, not a nicety.** Every spring animates from its
 * live presentation value: re-targeting mid-flight reads what is currently on screen
 * rather than the logical value, so an interrupted animation continues from where it
 * looks like it is instead of snapping back. Input is never locked during a
 * transition. `motion` gives this for free — its `animate()` reads the subject's
 * current value as the initial keyframe (see `readValueFromInstance` /
 * `getValueTransition`'s "used as the initial keyframe when `animate()` creates a
 * motion value for the subject" in `motion-dom/dist/index.d.ts`) and each spring's
 * generator exposes `retarget(keyframes, velocity)` to re-aim from the current
 * position *and* velocity, reusing the resolved physics. So nothing here has to
 * implement interruption, and nothing here may opt out of it.
 *
 * ## Why `bounce` and not `damping` + `response`
 *
 * The spec table was written against the Motion One spring API
 * (`{ damping, response }`). motion v14.0.0 no longer has `response` at all — it is
 * absent from `motion-dom`'s `SpringOptions`, and a bare `damping` alone is a
 * *physics* spring that ignores any duration: measured through
 * `spring({ keyframes: [0, 1], damping: 1.0, response: 0.3 })` the resulting animation
 * settles after **10 700 ms**. Setting `damping` also explicitly switches resolution
 * to physics and discards `duration`/`bounce` (see `getSpringOptions`'s
 * `isTimeDefined`).
 *
 * v14's duration-based spring is `{ duration, bounce }`, and `bounce` maps to a
 * damping ratio the SwiftUI way — `1 - bounce`, clamped at `0.05` — so the two are
 * one-to-one. Every spec damping below is therefore transcribed as its exact
 * `bounce` equivalent, and the durations are kept.
 *
 * ## `duration` is SECONDS — for a spring and for a tween alike
 *
 * motion-dom's `DurationSpringOptions` documents the default as `0.3` and
 * `visualDuration` as "a time, set in seconds". This file previously carried the
 * millisecond literals (`200`, `300`, …) the spec's `response` seconds were
 * mis-transcribed into — and motion read each of them as *seconds*, so `findSpring`
 * clamped every preset to a ten-second spring. Every "spring" in the app was therefore
 * a slow crawl, and the Media/Downloads pill — specced as a 200ms snap — had covered
 * barely an eighth of its travel a full second after the click. That is the "sluggish
 * and delayed" tab switch, and it was the unit, not the driver. The values below are
 * now the seconds the spec table actually meant, verified through `animate()` in
 * Chromium: `{ bounce: 0.3, duration: 0.2 }` reaches 90% at ~60ms and settles at
 * ~160ms with ~4% overshoot.
 */
import type { AnimationOptions } from "motion";

/**
 * The four springs (spec §4.5).
 *
 * `material` is critically damped so a dialog does not wobble on the way in.
 * `thrown` and `checkbox` are deliberately under-damped: the selection bar "was
 * thrown, not faded in" and a control the user just pressed (the checkbox check, the
 * `Segmented` indicator) wants the small overshoot that reads as a snap. Those
 * are the only places overshoot is wanted — everywhere else it is a bug.
 *
 * A control must also *not* borrow `material`. A critically damped spring has a slow
 * start: at a third of the way through a `material` surface's travel, most of the
 * distance is still ahead of it. On a 130px segmented pill that reads as lag, not
 * weight. `checkbox` front-loads its travel and settles inside ~160ms. `material` is
 * for surfaces that arrive.
 *
 * Typed as `AnimationOptions` (motion's third `animate()` argument, re-exported
 * through `motion` → `framer-motion/dom` → `motion-dom`) so a caller passes a preset
 * straight to `animate()` with no cast. `as const` keeps each preset's literals, so
 * `satisfies` narrows without widening to `AnimationOptions`.
 */
export const springs = {
  /** Dialog / sheet / popover enter+exit. Critically damped, no bounce. */
  material: { type: "spring", bounce: 0, duration: 0.3 },
  /** The selection bar. `bounce: 0.2` = the spec's damping 0.8 — "thrown, not faded". */
  thrown: { type: "spring", bounce: 0.2, duration: 0.3 },
  /** Filter chip add / remove. Critically damped — a chip is not a projectile. */
  chip: { type: "spring", bounce: 0, duration: 0.25 },
  /**
   * Control snap — the checkbox check and the `Segmented` indicator.
   * `bounce: 0.3` = the spec's damping 0.7. These are the two places overshoot is wanted:
   * on a control the user just pressed, the small overshoot is what makes it read as a
   * press rather than a fade. ~4% of travel — ~5px on a 130px pill.
   */
  checkbox: { type: "spring", bounce: 0.3, duration: 0.2 },
} as const satisfies Record<string, AnimationOptions>;

/**
 * The one tween the spec allows: value crossfade on opacity only (spec §4.5).
 *
 * Anything that moves or resizes is a spring. Opacity is the exception because
 * there is no momentum to interpolate — and because a crossfade that also moved
 * would be the "fade + slide" §4.5 rules out. Seconds here, as in `springs`.
 */
export const crossfade = { duration: 0.15, ease: "easeOut" } as const satisfies AnimationOptions;

/**
 * Progressive resistance past a bound (spec §4.5, "Rubber-banding at both bounds").
 *
 * The formula is the spec's, verbatim: resistance grows with the overshoot and
 * asymptotes at `dimension * constant`, so the edge can never be dragged off-screen
 * no matter how far the pointer travels. At the 400px minimum, 0.55 gives a ceiling
 * of 220px of give — roughly half a bound, which is as much slack as a grip needs
 * before it stops feeling attached to the pointer.
 *
 * @param overshoot  px past the bound; sign is preserved so the caller can keep
 *                    the grip visually attached to the edge.
 * @param dimension   the bound's full extent, used to scale resistance with size.
 * @param constant  Apple's 0.55. Higher is stiffer; this is the value iOS uses.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Narrowest the popup may be dragged. Below this the layout starts to break. */
export const POPUP_MIN_WIDTH = 400;

/** Widest the popup may be dragged. Past this it stops being a popup. */
export const POPUP_MAX_WIDTH = 720;

/** Where the popup opens when nothing has been persisted yet (spec D5). */
export const POPUP_DEFAULT_WIDTH = 460;

/**
 * Whether the user has asked for reduced motion.
 *
 * CSS clamps durations inside `theme.css`'s `prefers-reduced-motion` block, but the
 * springs in §4.5 are JS-driven and CSS cannot stop them. Every component that calls
 * `animate()` has to ask this first and fall back to a plain opacity crossfade — so it
 * lives here rather than being re-derived by each of them.
 *
 * Read once per call rather than cached in a module variable: the user can flip the
 * OS setting while the popup is open, and a stale cache would ignore it.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
