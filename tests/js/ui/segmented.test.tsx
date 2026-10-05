/**
 * The segmented control's indicator: the tab-switch animation's performance contract.
 *
 * These assertions are about *what gets animated*, not how it looks. The bug they lock
 * down was `animate(bar, { x, width }, spring)` — `width` is not an accelerated value, so
 * including it dropped the whole indicator animation off WAAPI onto motion's main-thread
 * JS driver, writing `style.width` and forcing a layout of the popup subtree on every one
 * of ~11 frames. The segments are `flex-1`, so for the view control every segment is
 * already the same width and that animation was interpolating a constant: pure cost, no
 * visible movement.
 *
 * Mocking `animate` is the correct seam for that. The defect *is* the argument — a
 * browser-free assertion that the keyframes are compositor-friendly is exactly the guard
 * needed, and a real-browser timing test would only tell us it again once it regressed.
 */
import { signal, type Signal } from "@preact/signals";
import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const animate = vi.fn((..._args: unknown[]) => ({ stop: vi.fn(), finished: Promise.resolve() }));
vi.mock("motion", () => ({ animate: (...args: unknown[]) => animate(...(args as [])) }));

const { Segmented } = await import("../../../src/ui/components/Segmented.js");
const { springs } = await import("../../../src/ui/motion.js");

const SEGMENTS = [
  { value: "media", label: "Media" },
  { value: "downloads", label: "Downloads" },
] as const;

/** A component, not a bare call: reading the signal during *its* render is what makes
 *  `@preact/signals` re-render it when the click writes it. */
function Harness({ value }: { value: Signal<string> }) {
  return (
    <Segmented
      ariaLabel="Popup view"
      segments={SEGMENTS}
      value={value.value}
      onChange={(next) => {
        value.value = next;
      }}
    />
  );
}

function renderSegmented() {
  const value = signal<string>("media");
  const result = render(<Harness value={value} />);
  // The mount effect positions the bar and starts one animation; clear it so each test
  // measures only what its own click did.
  animate.mockClear();
  return {
    ...result,
    bar: result.container.querySelector("span[aria-hidden]") as HTMLElement,
    value,
  };
}

/** `act`, not a bare `.click()`: writing the signal schedules the re-render, and an
 *  unwrapped click would assert against the previous tree. */
async function click(container: Element, index: number) {
  await act(async () => {
    container.querySelectorAll<HTMLElement>('[role="radio"]')[index].click();
  });
}

beforeEach(() => {
  animate.mockClear();
  // happy-dom reports no layout, so every offset is 0. The value does not matter to these
  // assertions — the *shape* of the animation is what is under test.
});

afterEach(cleanup);

describe("Segmented indicator", () => {
  it("animates transform only — no width, no layout property", async () => {
    const { container } = renderSegmented();

    await click(container, 1);

    expect(animate).toHaveBeenCalledTimes(1);
    const [subject, keyframes, options] = animate.mock.calls[0];
    expect(Object.keys(keyframes as Record<string, unknown>)).toEqual(["x"]);
    expect(options).toMatchObject({ ...springs.checkbox, type: "spring" });
    expect(subject).toBeInstanceOf(HTMLElement);
  });

  it("settles inside the 150–200ms window the interaction is specced for", () => {
    // Guards the *target*, so swapping in a longer preset fails here rather than shipping
    // as a regression report. `duration` is SECONDS in motion v14 — the range itself is
    // the unit guard: the old millisecond literal (`200`) was read as 200 seconds and
    // clamped to a ten-second spring, which is exactly the bug this file exists for.
    // Measured through `animate()` in Chromium: 90% of travel at ~60ms, settled at ~160ms.
    const { duration } = springs.checkbox;
    expect(duration).toBeGreaterThanOrEqual(0.15);
    expect(duration).toBeLessThanOrEqual(0.2);
  });

  it("writes the pill's width once per switch rather than animating it", async () => {
    const { container, bar } = renderSegmented();
    await click(container, 1);

    expect(bar.style.width).toMatch(/^\d+(\.\d+)?px$/);
    expect(animate.mock.calls.every((call) => !("width" in (call[1] as object)))).toBe(true);
  });

  it("retargets instead of queueing when clicked again mid-flight", async () => {
    const { container } = renderSegmented();
    await click(container, 1);
    const first = animate.mock.results[0].value as { stop: ReturnType<typeof vi.fn> };

    await click(container, 0);

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it("does not start any animation when the user asked for reduced motion", async () => {
    const query = vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);

    const { container, bar } = renderSegmented();
    await click(container, 1);

    expect(animate).not.toHaveBeenCalled();
    expect(bar.style.transform).toMatch(/translateX\(/);
    expect(bar.style.width).toMatch(/px$/);
    query.mockRestore();
  });

  it("keeps the pill from flashing at the origin on first paint", () => {
    // No opacity gate any more: the layout effect positions the bar before the first
    // paint, so there is no origin frame to hide. A re-introduced gate would show up
    // here as `opacity-0` on the bar.
    const { bar } = renderSegmented();
    expect(bar.className).not.toMatch(/opacity-/);
  });

  it("places the pill without animating on first mount", () => {
    // The first placement is a layout, not a move: no spring runs, so the pill cannot
    // slide in from the origin before the popup has been sized — the wrong-position pill
    // on first open. This renders directly rather than through `renderSegmented`, whose
    // post-mount `mockClear` would hide a mount-time animation.
    render(<Harness value={signal<string>("downloads")} />);
    expect(animate).not.toHaveBeenCalled();
  });
});
