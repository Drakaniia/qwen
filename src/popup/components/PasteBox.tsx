import { useEffect, useRef, useState } from "preact/hooks";

import { Button } from "../../ui/components/Button.js";
import { Icon } from "../../ui/Icon.js";
import { resolvePastedUrl } from "../popup_url_events.js";

/**
 * The smart paste box (spec §6.5, D19, D20).
 *
 * ## One input, one button
 *
 * `#manualUrl` and `#musicLinkUrl` are both deleted. They were two inputs over one
 * candidate array with two near-identical resolve flows, and the split only ever
 * existed so the Music tab could have its own box (D7 removed that tab).
 *
 * ## No client-side classification
 *
 * There is no host sniffing, no extension check and no "is this audio?" branch. D19:
 * "The smart paste box **does not guess** video vs audio. The native host resolves it
 * and the returned dialog already knows." Spec §6.5 puts the reason plainly: guessing
 * wrong is worse than waiting. So the box submits a string and lets
 * `resolvePastedUrl` decide what it is.
 *
 * ## Pending is a skeleton, not a spinner
 *
 * §6.5: "the label becomes a spinner-free shimmer placeholder (skeletons, not
 * spinners)". The button's label is replaced by a shimmering block of the same width,
 * so the row does not reflow and nothing in the popup spins.
 */
export function PasteBox() {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    pasteInput = inputRef.current;
    return () => {
      pasteInput = null;
    };
  }, []);

  // The hint is for an *empty focused* box only (spec §6.5): a placeholder that
  // reappears under text the user is still typing through is noise, and one that shows
  // while the box is unfilled and blurred competes with the real placeholder.
  const hint = focused && !value ? "Ctrl+V a link..." : "Paste a link...";

  async function submit(event: Event) {
    event.preventDefault();
    if (pending) {
      return;
    }
    setPending(true);
    try {
      // `resolvePastedUrl` resolves when the sheet is up, not when the download starts,
      // so the shimmer covers the helper round-trip and nothing after it.
      if (await resolvePastedUrl(value)) {
        setValue("");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} class="flex items-stretch gap-2 px-4 pt-3">
      <div class="relative flex min-w-0 flex-1 items-center rounded-input border border-border bg-surface focus-within:border-accent focus-within:outline-2 focus-within:outline-accent">
        <Icon name="link" size={14} class="ml-2 shrink-0 text-text-tertiary" />
        <input
          ref={inputRef}
          type="url"
          spellcheck={false}
          autoComplete="off"
          placeholder={hint}
          aria-label="Paste a link to download"
          value={value}
          disabled={pending}
          onInput={(event) => setValue(event.currentTarget.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          // Enter submits the form, which is what `submit` is wired to. The old
          // implementation only bound Enter on the music input and left the video one
          // needing its button clicked.
          class="min-w-0 flex-1 bg-transparent px-2 py-2 text-body text-text outline-none placeholder:text-text-muted"
        />
      </div>

      <Button type="submit" variant="primary" disabled={pending} aria-busy={pending} class="shrink-0">
        {pending ? (
          // An empty inline-block has no height of its own, so without `h-3` this shimmer
          // rendered 0px tall and the pending button read as blank. Same box as `VideoRow`'s.
          <span class="inline-block h-3 w-16 animate-pulse rounded-badge bg-accent-fg/40" aria-hidden="true" />
        ) : (
          "Download"
        )}
      </Button>
    </form>
  );
}

/**
 * Focus the paste box from elsewhere in the popup.
 *
 * The "Try a link instead" empty state (spec §6.10) has to move focus here, and the
 * box has no ref at that level. A module-level holder is the smallest thing that works
 * — the alternative is threading a ref through the frame and both views, which is four
 * props and a callback for one call.
 */
let pasteInput: HTMLInputElement | null = null;

export function focusPasteBox(): void {
  if (!pasteInput) {
    return;
  }
  pasteInput.focus();
  pasteInput.select();
}
