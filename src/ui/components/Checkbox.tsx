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
        class="peer sr-only"
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
