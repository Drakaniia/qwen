import logo from "./logo.png";

/**
 * The Qwin mark (spec §6.2). `alt=""` because every header that renders it also renders
 * the word "Qwin" beside it, so an image description would only repeat the title.
 *
 * `logo.png` is the 128px cut of the master art — enough for 28px at 3x DPI. Vite emits
 * it as a hashed asset under `assets/`, not inlined, so all three pages share one copy.
 *
 * The art is a full-bleed square, so the corner radius is applied in CSS (`rounded-badge`,
 * the 6px step from the scale in `theme.css` §5.3) rather than baked into the PNG: at 28px
 * that is ~21%, the macOS icon proportion, and it keeps the master art reusable at any size.
 */
export function Logo({ class: className = "" }: { class?: string }) {
  return <img src={logo} alt="" class={`size-7 shrink-0 rounded-badge ${className}`.trim()} />;
}
