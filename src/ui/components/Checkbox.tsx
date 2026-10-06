import { animate } from "motion";
import type { Ref } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { Icon } from "../Icon.js";
import { springs } from "../motion.js";

export interface CheckboxProps {
  checked: boolean;
  onChange(checked: boolean): void;
  /** Visible text beside the box. Usually absent on a media row, which labels itself. */
  label?: string;
  /** Required unless `label` is visible — the box is often the row's only control. */
  ariaLabel?: string;
  indeterminate?: boolean;
  disabled?: boolean;
  name?: string;
  value?: string;
  class?: string;
  ref?: Ref<HTMLInputElement>;
}

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Batch-selection checkbox (spec §5.2, D21).
 *
 * A real `<input type="checkbox">`, visually hidden behind a drawn box, so form
 * semantics, keyboard operation and `aria-checked` all come from the platform instead
 * of being reimplemented on a `div`. `peer-*` on the input drives the box, so the state
 * has exactly one owner.
 *
 * The check springs in on `springs.checkbox` (`damping 0.7`) — the one place in the
 * app where the overshoot is load-bearing, because a check that overshoots reads as a
 * snap and one that fades reads as a repaint (spec §4.5).
 *
 * ## Why the input is not `sr-only`
 *
 * It was, and the drawn box below it is `pointer-events-none`, so the only pixels that
 * reached the control were the 1×1 clipped `sr-only` box (`width: 1px; height: 1px;
 * clip-path: inset(50%)` — verified in the built `style-*.css`) parked in one corner of
 * the 16px cell. A caller with no `label` — the media row, whose `ariaLabel` names a row
 * that labels itself — therefore had **no hit area at all**: the box could be made
 * visible and still be unclickable, which is exactly the reported symptom.
 *
 * So the input is the hit area: `absolute inset-0 size-full opacity-0`, transparent but
 * full-bleed and still in the accessibility tree, drawn under the `pointer-events-none`
 * box because it comes first in the DOM. `size-full` is load-bearing — an absolutely
 * positioned replaced element with `width: auto` takes its intrinsic width and ignores
 * the over-constrained `right`, so `inset-0` alone would leave it 1px wide again.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  ariaLabel,
  indeterminate = false,
  disabled = false,
  name,
  value,
  class: className,
  ref,
}: CheckboxProps) {
  const markRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const on = checked || indeterminate;

  // `indeterminate` is a DOM property with no attribute, so there is no declarative way
  // to set it and the batch bar's "some but not all" state has to go through an effect.
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  useEffect(() => {
    const mark = markRef.current;
    if (!mark || indeterminate || !on || reducedMotion()) {
      return;
    }
    const controls = animate(mark, { scale: [0.4, 1], opacity: [0.4, 1] }, { ...springs.checkbox, type: "spring" });
    return () => controls.stop();
  }, [on]);

  const box = (
    <span class="relative inline-flex size-4 shrink-0">
      <input
        ref={(node) => {
          inputRef.current = node;
          if (typeof ref === "function") {
            ref(node);
          } else if (ref) {
            ref.current = node;
          }
        }}
        type="checkbox"
        class="peer absolute inset-0 size-full cursor-pointer opacity-0"
        checked={checked}
        disabled={disabled}
        name={name}
        value={value}
        aria-label={label ? undefined : ariaLabel}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span
        aria-hidden="true"
        class={`pointer-events-none absolute inset-0 flex items-center justify-center rounded-badge border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
          on ? "border-accent bg-accent" : "border-border-strong bg-surface"
        } ${disabled ? "opacity-50" : ""}`.trim()}
      >
        {indeterminate ? (
          <span class="h-0.5 w-2 rounded-full bg-accent-fg" />
        ) : (
          <span
            ref={markRef}
            class="text-accent-fg"
            style={{ transform: on ? undefined : "scale(0.4)", opacity: on ? 1 : 0 }}
          >
            <Icon name="checkmark" size={12} strokeWidth={2.4} />
          </span>
        )}
      </span>
    </span>
  );

  if (!label) {
    return <span class={`inline-flex ${className || ""}`.trim()}>{box}</span>;
  }

  return (
    <label class={`inline-flex items-center gap-2 text-body text-text select-none ${className || ""}`.trim()}>
      {box}
      {label}
    </label>
  );
}
