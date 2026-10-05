import { note } from "./state.js";

/**
 * One control's confirmation (spec §8).
 *
 * The page used to carry a single status line at its foot, which made the user look
 * away from the control they had just changed in order to discover it worked. This is
 * keyed by field instead, so the note lands beside the thing that changed, and it is
 * live-region text rather than a glyph — `role="status"` and `aria-live="polite"` mean
 * the confirmation is announced whether or not anyone can see it.
 *
 * The fade is a 150ms opacity crossfade, spec §4.5's one permitted tween, and it
 * survives `prefers-reduced-motion`: §4.6 clamps durations to 150ms rather than to
 * nothing. A confirmation is comprehension, not decoration.
 */
export function Saved({ field }: { field: string }) {
  const current = note.value;
  if (!current || current.field !== field) {
    return null;
  }
  return (
    <p
      role="status"
      aria-live="polite"
      class={`text-caption transition-opacity duration-150 ${
        current.error ? "text-critical" : "text-success"
      } ${current.shown ? "opacity-100" : "opacity-0"}`}
    >
      {current.text}
    </p>
  );
}
