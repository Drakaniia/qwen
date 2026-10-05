import { useId } from "preact/hooks";
import type { ComponentChildren } from "preact";

export interface FieldRenderProps {
  /** Pass to the control's `id` so the `<label>` points at it. */
  id: string;
  /** Pass to the control's `aria-describedby`. Undefined when there is nothing to describe. */
  describedBy: string | undefined;
}

export interface FieldProps {
  label: string;
  children: (props: FieldRenderProps) => ComponentChildren;
  hint?: string;
  /**
   * Transient feedback ("Settings saved."). Announced politely, mirroring
   * `#settingsStatus` / `#syncStatus`. Rendered only when non-empty.
   */
  status?: string;
}

/**
 * Label + control + hint + status line. The control is a render prop rather than a
 * `children` node so the generated ids have exactly one owner and the label and
 * `aria-describedby` can never drift out of sync with the control.
 *
 * Props are unchanged by the redesign (spec §5.2) — only the type scale moved onto
 * the shared roles, so a field label matches a row title and a hint matches the
 * 11px caption used everywhere else.
 */
export function Field({ label, hint, status, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const statusId = `${id}-status`;
  const describedBy = [hint ? hintId : null, status ? statusId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div class="flex flex-col gap-1">
      <label for={id} class="text-row text-text">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint ? (
        <p id={hintId} class="text-caption text-text-muted">
          {hint}
        </p>
      ) : null}
      {status ? (
        <p id={statusId} role="status" aria-live="polite" class="text-caption text-text-muted">
          {status}
        </p>
      ) : null}
    </div>
  );
}
