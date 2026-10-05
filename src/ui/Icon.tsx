import type { JSX } from "preact";

/**
 * The one icon set for all four surfaces (spec §4.4).
 *
 * Every glyph is a 24×24 stroke path at `stroke-width: 1.6`, round caps and round
 * joins — the SF-Symbols-alike weight, and deliberately *not* the per-surface weights
 * the old inline SVGs carried. `popup.html` alone had a `stroke-width="2"` rescan
 * glyph, a filled gear and two filled layout glyphs in the same 32px row; they read as
 * three different icon sets because they were three different sets.
 *
 * The emoji this replaces (`⚠️`, `▶`, `📋`, `✓`, `✗`) are the reason the component
 * exists at all: per spec §1.6 they do not align to a 4px grid, so a 12px banner
 * chevron sat a half-pixel off the text it was supposed to line up with, and the
 * `✓`/`✗` pair in Options had visibly different weights at 13px. Glyph metrics are the
 * one thing a font substitution cannot be trusted to hold still.
 *
 * Names are SF-Symbols vocabulary (`exclamationmark.triangle`, not `warning`) so the
 * set is greppable against the platform it is imitating, and so a name that is not
 * obviously SF — `line.3.horizontal`, `folder.badge.gearshape` — still sorts next to
 * its neighbours. Where two names are genuinely one glyph (`gear` / `gearshape`) both
 * exist as names and share geometry: the name set is the contract callers code
 * against, not the drawing.
 */
interface IconGeometry {
  readonly d: string;
  /**
   * Draw with `currentColor` fill instead of stroking. Also switches the path to
   * `fill-rule="evenodd"`, which is how the `.fill` variants knock their glyph out of
   * the disc: the glyph is a second subpath inside the circle, so even-odd punches it
   * out without needing a second colour or a `<mask>`.
   */
  readonly filled?: boolean;
}

// Hoisted only because two names share it — see `gear` below.
const GEAR =
  "M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z " +
  "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z";

// One literal entry per name, at module scope, so an unreferenced icon is a dropped
// property rather than a branch the bundler has to prove unreachable.
const ICONS = Object.freeze({
  // ─── Replaces: the emoji and text characters already in the UI ───────────────
  "exclamationmark.triangle": { d: "M12 4 3.5 19.5h17L12 4Z M12 10v4 M12 16.6h.01" },
  "chevron.right": { d: "M9.5 5.5 16 12l-6.5 6.5" },
  "doc.on.doc": {
    d: "M9 8.5h9.5a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19.5V10A1.5 1.5 0 0 1 6.5 8.5H9 M9 8.5V6a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 20 6v8a1.5 1.5 0 0 1-1.5 1.5h-2.5 M10 13.5h6 M10 16.5h4",
  },
  checkmark: { d: "M4.5 12.5l5 5 10-11" },
  xmark: { d: "M6 6l12 12 M18 6 6 18" },

  // ─── Actions ───────────────────────────────────────────────────────────────
  download: { d: "M12 3.5v11 m0 0 4-4 m-4 4-4-4 M4.5 19.5h15" },
  "download.circle": { d: "M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6Z M12 8v7.5 m0 0 3-3 m-3 3-3-3" },
  "arrow.clockwise": { d: "M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4m-4 4a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4" },
  trash: {
    d: "M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M10 11v6 M14 11v6",
  },
  folder: {
    d: "M3 7.5A1.5 1.5 0 0 1 4.5 6h4L11 8.5h8.5A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V7.5Z",
  },
  "square.and.arrow.down": {
    d: "M12 3.5v10 m0 0 3.5-3.5 M12 13.5 8.5 10 M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15",
  },
  "square.and.arrow.up": { d: "M12 13.5v-10 m0 0L8.5 7 M12 3.5 15.5 7 M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" },
  "arrow.up.doc": { d: "M12 15.5V4 m0 0L8.5 7.5 M12 4l3.5 3.5 M4.5 14v4.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V14" },

  // ─── Chrome and navigation ─────────────────────────────────────────────────
  // `gearshape` is the same drawing as `gear`. Two names survive because callers
  // reach for the SF name in one place and the plain English name in another, and
  // collapsing them would force one of those surfaces to know about the other's
  // vocabulary.
  gear: { d: GEAR },
  gearshape: { d: GEAR },
  "folder.badge.gearshape": {
    d: "M3 8.5A1.5 1.5 0 0 1 4.5 7h4L10 9.5h7.5A1.5 1.5 0 0 1 19 11v1 M3 8.5V17a1.5 1.5 0 0 0 1.5 1.5H11 M17 14.5a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z M17 13.6v.9 M17 20v.9 M15.5 14.6l-.6.6 M19.1 19.4l-.6.6 M14.6 17h.9 M18.5 17h.9 M15.5 19.4l-.6-.6 M19.1 14.6l-.6-.6",
  },
  "music.note": { d: "M9 18V5l12-2v13 M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" },
  magnifyingglass: { d: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z M20.5 20.5l-4.4-4.4" },
  // The empty-page state, not the scanning one: a magnifying glass here would restate the
  // metaphor `SkeletonRow` already owns, so the glyph says "no video" instead.
  film: { d: "M3.5 6.5h17v11h-17z M7.5 6.5v11 M16.5 6.5v11 M3.5 12h17 M7.5 9.75v4.5 M16.5 9.75v4.5" },
  "chevron.down": { d: "M5.5 9.5 12 16l6.5-6.5" },
  "chevron.up": { d: "M5.5 14.5 12 8l6.5 6.5" },
  "slider.horizontal.3": {
    d: "M3.5 7.5h9.5 M17.5 7.5h3 M3.5 16.5h2.5 M10.5 16.5h10 M15 5.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z M8 14.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z",
  },
  "line.3.horizontal": { d: "M5 8.5h14 M5 12h14 M5 15.5h14" },
  link: {
    d: "M9.5 14.5 14.5 9.5 M10.5 6.5l1.8-1.8a4.1 4.1 0 0 1 5.8 5.8l-1.8 1.8 M13.5 17.5l-1.8 1.8a4.1 4.1 0 0 1-5.8-5.8l1.8-1.8",
  },

  // ─── Transport ──────────────────────────────────────────────────────────────
  // Solid, not stroked: a stroked play triangle reads as an outline and loses its
  // silhouette at 14px, which is the size the download row gives it.
  play: { d: "M8 5.5v13l11-6.5-11-6.5Z", filled: true },
  pause: { d: "M7.5 5h3v14h-3Z M13.5 5h3v14h-3Z", filled: true },
  stop: { d: "M6.5 6.5h11v11h-11Z", filled: true },
  bolt: { d: "M13.5 3 6 13.2h4.6L10.2 21 18 10.6h-4.7L13.5 3Z", filled: true },

  // ─── Status ─────────────────────────────────────────────────────────────────
  clock: { d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 7.5V12l3 1.8" },
  "info.circle": { d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 11v5.5 M12 7.8h.01" },
  "exclamationmark.circle": { d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 7.6v5 M12 15.9h.01" },
  "questionmark.circle": {
    d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M9.6 9.4a2.5 2.5 0 0 1 4.85.8c0 1.65-2.45 2.2-2.45 3.8 M12 16.4h.01",
  },
  "checkmark.circle": { d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M8 12.2l2.8 2.8 5.4-6" },
  // The check and the x below are authored as closed ribbons rather than stroked
  // polylines, so `evenodd` can cut them out of the disc. A stroked glyph would need
  // a second colour or a mask to survive on a filled disc.
  "checkmark.circle.fill": {
    d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M7.26 13.04 11.7 14.52 17 9.68 15.4 8.32 10.1 15.88 8.74 11.56Z",
    filled: true,
  },
  "xmark.circle.fill": {
    d: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M8.64 7.16 12 10.52 15.36 7.16 16.84 8.64 13.48 12 16.84 15.36 15.36 16.84 12 13.48 8.64 16.84 7.16 15.36 10.52 12 7.16 8.64Z",
    filled: true,
  },
} satisfies Record<string, IconGeometry>);

// The union is derived, not restated, so a name cannot be in the contract and missing
// from the drawing (or vice versa).
export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Pixels. Defaults to 16. */
  size?: number;
  class?: string;
  /** Defaults to 1.6. Only override for optical sizing on tiny icons. */
  strokeWidth?: number;
  /**
   * Accessible name. When omitted the icon is aria-hidden — which is the correct
   * default for an icon sitting next to a text label. Pass a `title` ONLY for an
   * icon that is the sole content of a control (e.g. the rescan button).
   */
  title?: string;
}

/**
 * One 24×24 stroked glyph. `currentColor` throughout so the icon inherits whatever
 * Tailwind text utility its container already carries — there is no per-icon colour
 * to keep in sync with the theme.
 */
export function Icon({ name, size = 16, class: className, strokeWidth = 1.6, title }: IconProps): JSX.Element {
  // `satisfies` keeps each entry's exact literal type (which is what makes the union
  // below derivable) but does not widen it, so the read is annotated rather than the
  // table — annotating the table would collapse the union to `string`.
  const icon: IconGeometry = ICONS[name];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      class={className}
    >
      {title ? <title>{title}</title> : null}
      <path
        d={icon.d}
        fill={icon.filled ? "currentColor" : undefined}
        fill-rule={icon.filled ? "evenodd" : undefined}
      />
    </svg>
  );
}

export type StatusDotState = "success" | "critical" | "caution" | "neutral";

// Colour comes from the token layer, not from here, so `success`/`critical`/`caution`
// stay one name across all four surfaces. `text-*` on the wrapper and `bg-current` on
// the dot means the three states share one shape, one size and one transition and
// differ only in which token resolves (spec §4.4, §6.2).
const DOT_COLOR: Record<StatusDotState, string> = {
  success: "text-success",
  critical: "text-critical",
  caution: "text-caution",
  // "No data yet", so the tertiary text token rather than `caution`: amber reads as a
  // real warning about a known bad state, which is exactly what "never checked" is
  // not. See native-helper-status-spec.md §5 Step 4.
  neutral: "text-text-tertiary",
};

/**
 * The helper-availability dot (spec §4.4), replacing the hand-drawn bordered circle
 * that `popup.html` carried as `#downloadIndicator`. Spec §6.2 is explicit that a bare
 * coloured circle is not an accessible status, so the label travels with the shape as
 * visually-hidden text inside a live region.
 *
 * The caution pulse is Tailwind's `animate-pulse` rather than a keyframe here: spec
 * §4.6 requires `prefers-reduced-motion: reduce` to stop it, and that override is a
 * CSS concern owned with the other reduced-motion rules (see the block in
 * `popup-theme.css`). No inline `<style>` and no hand-rolled animation to keep in sync.
 */
export function StatusDot({
  state,
  label,
  class: className,
}: {
  state: StatusDotState;
  label: string;
  class?: string;
}): JSX.Element {
  return (
    <span role="status" class={`inline-flex items-center gap-1.5 ${DOT_COLOR[state]} ${className || ""}`.trim()}>
      <span
        aria-hidden="true"
        class={`size-2 shrink-0 rounded-full bg-current transition-colors ${state === "caution" ? "animate-pulse" : ""}`.trim()}
      />
      <span class="sr-only">{label}</span>
    </span>
  );
}
