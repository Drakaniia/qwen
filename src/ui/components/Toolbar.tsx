import type { ComponentChildren } from "preact";

export interface ToolbarProps {
  /**
   * The leading slot, sized for the 8px status dot of spec §6.2. It sits beside
   * *both* the title and the caption, which is why it is a slot and not something
   * the caller has to splice into `title`.
   */
  leading?: ComponentChildren;
  title?: ComponentChildren;
  /** The 11px second line — "Helper connected · yt-dlp 2026.09.30". */
  caption?: ComponentChildren;
  /** Right-aligned controls: the theme Segmented, rescan, settings (spec §6.2). */
  actions?: ComponentChildren;
  /** Sticky for a page toolbar whose content scrolls under it (spec §7). */
  sticky?: boolean;
  class?: string;
  children?: ComponentChildren;
}

/**
 * The translucent chrome bar (spec §5.2). Three slots and no state of its own: the
 * popup header, the downloads toolbar and the options toolbar are the same bar with
 * different contents, and keeping the layout here is what stops three headers from
 * drifting apart.
 *
 * `.material-chrome` carries the translucency, the blur and the inset top highlight
 * (spec §4.1). There is no border: the inset highlight *is* the edge, and a 1px rule
 * under glass reads as a seam rather than as light catching a surface.
 */
export function Toolbar({
  leading,
  title,
  caption,
  actions,
  sticky = false,
  class: className,
  children,
}: ToolbarProps) {
  return (
    <header
      class={`material-chrome flex items-center gap-3 px-4 py-2 ${sticky ? "sticky top-0 z-20" : ""} ${
        className || ""
      }`.trim()}
    >
      {leading}
      {title || caption ? (
        <div class="flex min-w-0 flex-1 flex-col">
          {title ? <span class="truncate text-title text-text">{title}</span> : null}
          {caption ? <span class="truncate text-caption text-text-muted">{caption}</span> : null}
        </div>
      ) : (
        <div class="min-w-0 flex-1" />
      )}
      {actions ? <div class="flex shrink-0 items-center gap-2">{actions}</div> : null}
      {children}
    </header>
  );
}
