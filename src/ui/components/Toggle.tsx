import { useId } from "preact/hooks";
import type { TargetedEvent } from "preact";

export interface ToggleProps {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
  hint?: string;
  disabled?: boolean;
}

/**
 * Labelled on/off setting. A real `<input type="checkbox">` — not a styled
 * `div[role=switch]` — so it is keyboard-operable and form-associated for free.
 *
 * The shape is unchanged by the redesign (spec §5.2: "unchanged shape, restyled to
 * system colors"); only the type and spacing classes moved onto the shared scale.
 * `accent-accent` is left doing the work: the platform control already tracks the
 * OS light/dark scheme, which is one rung below anything we could draw.
 */
export function Toggle({ label, hint, checked, onChange, disabled }: ToggleProps) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          class="size-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onChange={(event: TargetedEvent<HTMLInputElement>) => onChange(event.currentTarget.checked)}
        />
        <label for={id} class="text-body text-text select-none">
          {label}
        </label>
      </div>
      {hint ? (
        <p id={hintId} class="pl-6 text-caption text-text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
