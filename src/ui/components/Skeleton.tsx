export type SkeletonRadius = "badge" | "row" | "input" | "card" | "sheet" | "dialog" | "full";

export interface SkeletonProps {
  /** CSS length. A caller that knows the box it is standing in for passes the real width. */
  width?: string;
  height?: string;
  radius?: SkeletonRadius;
  class?: string;
}

const RADII: Record<SkeletonRadius, string> = {
  badge: "rounded-badge",
  row: "rounded-row",
  input: "rounded-input",
  card: "rounded-card",
  sheet: "rounded-sheet",
  dialog: "rounded-dialog",
  full: "rounded-full",
};

/**
 * A placeholder block (spec §5.2: loading, not spinners; spec §6.5: the paste box's
 * pending state is a shimmer, not a spinner).
 *
 * `animate-pulse` rather than a hand-rolled shimmer sweep on purpose. It is one stock
 * class with no `@keyframes` to own, it is an opacity oscillation rather than motion
 * across the viewport, and spec §4.6's `animation-duration: 1ms !important` under
 * `prefers-reduced-motion: reduce` turns it into exactly the static tint the spec asks
 * for — with no second code path here.
 *
 * Width and height are CSS values rather than Tailwind classes so a caller can mirror
 * the box it is replacing without inventing a class name for it.
 */
export function Skeleton({ width, height, radius = "row", class: className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      class={`animate-pulse bg-raised ${RADII[radius]} ${className || ""}`.trim()}
      style={{ width, height }}
    />
  );
}

/**
 * The media row shape: thumbnail block plus two text lines (spec §6.6). Parameterless
 * until a surface needs a different row — the popup row and the downloads row are the
 * same geometry, and a prop with one value is a prop nobody sets.
 */
export function SkeletonRow() {
  return (
    <div class="flex items-center gap-3 px-3 py-2">
      <Skeleton width="80px" height="48px" radius="row" />
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton height="10px" width="70%" />
        <Skeleton height="8px" width="40%" />
      </div>
    </div>
  );
}
