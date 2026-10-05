import type { ComponentChildren, MouseEventHandler } from "preact";

/**
 * `default` is the pre-redesign name for a tinted button and is still what
 * `DownloadsPage.tsx:135` and `OptionsPage.tsx` pass; it is an alias of
 * `secondary` rather than a separate style, so the two names can never drift.
 */
export type ButtonVariant = "default" | "primary" | "secondary" | "plain" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  children: ComponentChildren;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** `primary` for the one action a view is for; a tint for everything else. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Marks a two-state button (view toggles, filters) — rendered as `aria-pressed`. */
  pressed?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  class?: string;
  title?: string;
  "aria-label"?: string;
}

// Shared shape. The focus ring is always present and only becomes visible on
// :focus-visible, so keyboard users get a ring and mouse users do not.
// `.pressable` is the house press feedback (spec §4.5: scale 0.97 on :active at
// 100ms ease-out) — CSS rather than a runtime spring, because a press has to
// start on the same frame as the pointer.
const BASE =
  "pressable inline-flex items-center justify-center rounded-row font-medium select-none " +
  "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";

// Colours are token-only. `theme.css` redefines each token under
// `prefers-color-scheme: dark`, so a class written once follows the scheme —
// adding a `dark:` prefix would restate what the token already says.
const VARIANTS: Record<ButtonVariant, string> = {
  default: "bg-raised text-text hover:bg-border",
  secondary: "bg-raised text-text hover:bg-border",
  plain: "bg-transparent text-text hover:bg-raised",
  primary: "bg-accent text-accent-fg hover:opacity-90",
  ghost: "bg-transparent text-text-muted hover:bg-raised hover:text-text",
};

// `md` is 34px, which is not on Tailwind's height scale. It is spelled out rather
// than rounded to `h-8`/`h-9` because the spec names 28/34/40 (spec §5.2) and a
// control's height is a type-scale metric, not one of the 4/8/12 spacing steps in
// spec §5.3. `theme.css` should absorb it as `--control-height-md`; until then
// this is the one arbitrary value in the system.
const HEIGHTS: Record<ButtonSize, { text: string; ghost: string }> = {
  sm: { text: "h-7 px-2 gap-1", ghost: "size-7" },
  md: { text: "h-[34px] px-3 gap-2", ghost: "size-[34px]" },
  lg: { text: "h-10 px-4 gap-2", ghost: "size-10" },
};

const TYPE: Record<ButtonSize, string> = {
  sm: "text-caption",
  md: "text-body",
  lg: "text-row",
};

export function Button({ variant = "secondary", size = "md", pressed, class: className, ...rest }: ButtonProps) {
  const height = HEIGHTS[size];

  return (
    <button
      type={rest.type ?? "button"}
      aria-pressed={pressed}
      class={`${BASE} ${TYPE[size]} ${variant === "ghost" ? height.ghost : height.text} ${VARIANTS[variant]} ${
        className || ""
      }`.trim()}
      {...rest}
    />
  );
}
