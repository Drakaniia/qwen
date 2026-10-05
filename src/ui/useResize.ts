/**
 * Pointer-driven popup resizing (spec §4.5, §6.1, acceptance #7).
 *
 * This replaces the fixed `w-[390px]` utility on `<body>` in `popup.html` — the popup
 * currently cannot be resized at all, and §6.1 makes its width user-owned.
 *
 * ## The width is never animated
 *
 * > "Direct manipulation. 1:1 with the pointer, zero easing. Any spring here is a bug."
 * > — spec §4.5
 *
 * Every frame of a drag writes the width straight onto `document.body.style.width`.
 * There is no `transition` on the property, no spring, and no `requestAnimationFrame`
 * throttle: the browser already delivers one `pointermove` per frame, so a throttle
 * would only add lag to an interaction whose entire quality is that it does not lag.
 * If you are reading this and thinking the width would look nicer easing into place,
 * that is the exact mistake §4.5 is written to prevent.
 *
 * ## No CSS transitions on anything gesture-driven
 *
 * Spec §4.5, verbatim: "Nothing gesture-driven uses a CSS transition." A transition
 * on the width would fight the pointer — every frame's new target would restart the
 * ease, so the edge would lag the cursor and the release would look broken. The grip
 * tracks through Pointer Events with `setPointerCapture` instead, which also means
 * the drag survives the pointer leaving the popup or the button being released
 * outside the window.
 *
 * ## Rubber-banding, not clamping
 *
 * Past `POPUP_MIN_WIDTH` / `POPUP_MAX_WIDTH` the grip still follows the pointer, at a
 * fraction of the distance (`rubberband()` from `./motion.js`). Clamping hard makes
 * the grip feel broken mid-drag; resisting makes the bound feel elastic. The sign is
 * preserved so the edge stays visually attached to the cursor on both sides.
 *
 * ## `prefers-reduced-motion`
 *
 * Nothing to reduce. There is no animation on the width, so the whole gesture is
 * already at the reduced-motion end of the spectrum. The *list reflow* spring that
 * §4.5 describes immediately after a resize is the caller's: `releaseVelocity` hands
 * over the measured px/ms and whoever owns the list decides what to do with it. This
 * hook deliberately does not know a list exists.
 */
import type { TargetedKeyboardEvent, TargetedPointerEvent } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import * as PopupApi from "../shared/popup_api.js";
import { POPUP_DEFAULT_WIDTH, POPUP_MAX_WIDTH, POPUP_MIN_WIDTH, rubberband } from "./motion.js";

/** Arrow keys move the edge in 16px steps — the same increment a native resizer uses. */
const KEYBOARD_STEP = 16;

/**
 * How far back the sample history reaches when measuring release velocity. 80ms is
 * roughly the last five pointermove events at 60Hz: long enough to average out jitter
 * from a hand stopping short, short enough that a deliberate flick still registers
 * before the user lifts.
 */
const HISTORY_WINDOW_MS = 80;

interface Sample {
  x: number;
  t: number;
}

/** Live gesture state. `null` when no drag is in flight. */
interface DragState {
  pointerId: number;
  element: HTMLElement;
  startX: number;
  /**
   * The width at pointerdown. The grip is grabbed *at* the edge, so the delta is
   * measured from this rather than from the cursor position — otherwise a pointerdown
   * 6px inside the edge teleports the edge to the cursor and the popup jumps.
   */
  startWidth: number;
  samples: Sample[];
}

export interface UseResize {
  /** Current width in px. Exceeds the bounds mid-drag while rubber-banding. */
  width: number;
  /**
   * px per millisecond measured at the last release. Hand this to the list-reflow
   * spring (§4.5); the sign follows the pointer. `0` for a keyboard resize.
   */
  releaseVelocity: number;
  /**
   * Clamp `width` (default: the current one) into the bounds, apply it, persist it and
   * return it. Called on pointerup, on pointercancel and on each arrow key.
   */
  commit: (width?: number) => number;
  /**
   * Spread onto the focusable grip element. All four pointer handlers are needed:
   * `setPointerCapture` retargets `pointermove`/`pointerup` at the grip even when the
   * cursor is far outside it, so the grip is also the drag's event surface.
   */
  gripProps: {
    onPointerDown: (event: TargetedPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: TargetedPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: TargetedPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: TargetedPointerEvent<HTMLElement>) => void;
    onKeyDown: (event: TargetedKeyboardEvent<HTMLElement>) => void;
    role: "separator";
    tabIndex: 0;
    "aria-orientation": "vertical";
    "aria-label": string;
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
  };
}

/** Where the width sits for a raw pointer-derived value, resisting past either bound. */
function withRubberband(raw: number): number {
  if (raw > POPUP_MAX_WIDTH) {
    return POPUP_MAX_WIDTH + rubberband(raw - POPUP_MAX_WIDTH, POPUP_MAX_WIDTH);
  }
  if (raw < POPUP_MIN_WIDTH) {
    return POPUP_MIN_WIDTH + rubberband(raw - POPUP_MIN_WIDTH, POPUP_MIN_WIDTH);
  }
  return raw;
}

/** px per ms across the samples still inside the window; `0` if there is no usable pair. */
function measureVelocity(samples: Sample[]): number {
  if (samples.length < 2) {
    return 0;
  }
  const last = samples[samples.length - 1];
  let first = samples[0];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > HISTORY_WINDOW_MS) {
      break;
    }
    first = samples[i];
  }
  const elapsed = last.t - first.t;
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

/**
 * Put the default width on `<body>` *before the popup renders*.
 *
 * The width has to exist before the first layout effect, not inside one: Preact runs
 * layout effects child-first, so `Segmented`'s indicator measured a popup that had not
 * been sized yet — `<body>` carries no width of its own (`popup.html`) — and pinned
 * itself to a narrow, left-anchored rectangle for the first frames of every open. (The
 * `ResizeObserver` in `Segmented` does correct it, but the popup's boot keeps the main
 * thread busy long enough that the correction lands well after the first paint.) Calling
 * this from the popup entry means `useResize` only ever *adjusts* a real width — to the
 * stored value, or in a drag — instead of introducing the first one.
 */
export function applyInitialWidth(): void {
  document.body.style.width = `${POPUP_DEFAULT_WIDTH}px`;
}

/**
 * Persist the width.
 *
 * Routed through the background's `saveSettings` handler rather than written to
 * `storage.local` directly: `tab_state.persistSettings` serialises the background's
 * *in-memory* settings object, so a direct write of `qwinSettings.popupWidth` would be
 * silently erased by the next settings write from anywhere else in the extension.
 * `updateSettings` merges, so one field is a safe write.
 */
async function persist(width: number): Promise<void> {
  await PopupApi.runtimeMessage({ type: "saveSettings", settings: { popupWidth: width } });
}

export function useResize(): UseResize {
  const [width, setWidth] = useState<number>(POPUP_DEFAULT_WIDTH);
  const [releaseVelocity, setReleaseVelocity] = useState<number>(0);

  // Mirror of `width`, for the event handlers: a drag outlives the render that
  // started it, and `apply` is called many times per gesture.
  const widthRef = useRef<number>(POPUP_DEFAULT_WIDTH);
  const dragRef = useRef<DragState | null>(null);

  const apply = useCallback((next: number): void => {
    const rounded = Math.round(next);
    widthRef.current = rounded;
    document.body.style.width = `${rounded}px`;
    setWidth(rounded);
  }, []);

  const commit = useCallback(
    (requested?: number): number => {
      const target = Math.min(POPUP_MAX_WIDTH, Math.max(POPUP_MIN_WIDTH, requested ?? widthRef.current));
      apply(target);
      void persist(target);
      return target;
    },
    [apply],
  );

  /** Release the capture and forget the gesture. Idempotent. */
  const finish = useCallback((): void => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = null;
    // `hasPointerCapture` rather than a bare call: a pointer that was already
    // released (pointercancel, then unmount) would otherwise throw.
    if (drag.element.hasPointerCapture(drag.pointerId)) {
      drag.element.releasePointerCapture(drag.pointerId);
    }
    // Text selection across the whole popup is the classic drag-a-resizer bug, and
    // `user-select` is the only thing that suppresses it mid-gesture.
    document.body.style.userSelect = "";
  }, []);

  const onPointerDown = useCallback((event: TargetedPointerEvent<HTMLElement>): void => {
    // A second pointer during an active gesture, or a non-primary button.
    if (dragRef.current || event.button !== 0) {
      return;
    }
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";
    dragRef.current = {
      pointerId: event.pointerId,
      element,
      startX: event.clientX,
      startWidth: widthRef.current,
      samples: [{ x: event.clientX, t: event.timeStamp }],
    };
  }, []);

  const onPointerMove = useCallback(
    (event: TargetedPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      // A pointer id that no longer matches is a gesture that has already ended —
      // its events are stale and must not move the edge.
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      drag.samples.push({ x: event.clientX, t: event.timeStamp });
      apply(withRubberband(drag.startWidth + (event.clientX - drag.startX)));
    },
    [apply],
  );

  const onPointerEnd = useCallback(
    (event: TargetedPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      // Same guard as `onPointerMove`: a `pointerup` from a pointer that is not the
      // one being dragged (a stray second finger, a stale queued event) must not end
      // this gesture and commit a width the user never chose.
      if (!drag || drag.pointerId !== event.pointerId) {
        return;
      }
      const velocity = measureVelocity(drag.samples);
      finish();
      commit();
      setReleaseVelocity(velocity);
    },
    [commit, finish],
  );

  const onKeyDown = useCallback(
    (event: TargetedKeyboardEvent<HTMLElement>): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      event.preventDefault();
      // No rubber-band: a keyboard step past a bound should stop at it. Flinging a
      // synthetic 16px past the edge would only make the next press a no-op.
      commit(widthRef.current + (event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP));
      // A keyboard resize has no release velocity. Zeroed here rather than inside
      // `commit` so the pointer path can set it *after* committing without the two
      // fighting over the same value.
      setReleaseVelocity(0);
    },
    [commit],
  );

  // The stored width, applied once on open.
  useEffect(() => {
    let cancelled = false;
    void PopupApi.runtimeMessage({ type: "getSettings" }).then((response) => {
      const stored = Number((response as { settings?: { popupWidth?: unknown } }).settings?.popupWidth);
      // Ignore a missing, unparseable or out-of-range stored value and keep the
      // default rather than clamping a corrupt value into a plausible-looking one.
      if (!cancelled && stored >= POPUP_MIN_WIDTH && stored <= POPUP_MAX_WIDTH) {
        apply(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // The escape hatch: a component unmounting mid-drag must not leave the pointer
  // captured and the popup stuck in a rubber-banded, unselectable state.
  useEffect(() => finish, [finish]);

  return {
    width,
    releaseVelocity,
    commit,
    gripProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onKeyDown,
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-label": "Resize popup",
      "aria-valuenow": width,
      "aria-valuemin": POPUP_MIN_WIDTH,
      "aria-valuemax": POPUP_MAX_WIDTH,
    },
  };
}
