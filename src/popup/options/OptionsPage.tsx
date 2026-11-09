/**
 * The options page (spec §8): everything that outlives a single popup visit.
 *
 * Restructured by *task* rather than by data source. The page used to be five flat
 * bordered cards in the order the data arrived, which meant "find the audio format"
 * cost a scroll past the native-helper status. It is now four task groups plus
 * Advanced, with a search field that narrows the page to the group a query names.
 *
 * The page shell — chrome, search, section layout — lives here; the controls live in
 * `sections.tsx`. There is no palette, no radius and no control height in either file:
 * every one is a `src/ui/` component or a `theme.css` token, and a second copy is
 * exactly how this project ended up with three (spec §1.2).
 */
import type { ComponentChildren, RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { loadAll, loaded, query } from "./state.js";
import { SECTIONS } from "./sections.js";
import { Icon } from "../../ui/Icon.js";
import { Logo } from "../../ui/Logo.js";
import { Toolbar } from "../../ui/components/Toolbar.js";

/** Boot the page. `loadSettings` is also what applies the stored appearance. */
export function startOptionsPage(): void {
  void loadAll();
}

/**
 * A labelled group of related controls.
 *
 * `terms` is the section's half of the search index: the words a user might type that
 * are not in the title. It is one string per section rather than a keyword table per
 * control, because the case this page has to serve is "show me the one section I am
 * looking for" — hiding four sections is the whole job, and a per-control index would
 * let a query leave a section visible with an empty card under its heading.
 */
function Section({
  title,
  status,
  children,
}: {
  title: string;
  status?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="material-content flex flex-col gap-4 rounded-card border border-border p-4">
      <div class="flex items-center gap-2">
        <h2 class="section-label text-section text-text-muted">{title}</h2>
        {status}
      </div>
      {children}
    </section>
  );
}

function SearchField({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const value = query.value;

  return (
    <div class="relative flex items-center">
      <Icon name="magnifyingglass" size={14} class="pointer-events-none absolute left-2 text-text-tertiary" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        aria-label="Search settings"
        placeholder="Search settings"
        onInput={(event) => {
          query.value = event.currentTarget.value;
        }}
        onKeyDown={(event) => {
          // Esc clears and blurs (spec §10). `/` inside the field is a literal character,
          // which is why the page-level shortcut stands down while focus is in an input.
          if (event.key === "Escape") {
            query.value = "";
            event.currentTarget.blur();
          }
        }}
        class="ring-focus h-control-md w-56 rounded-input border border-border bg-surface pl-7 pr-8 text-body text-text placeholder:text-text-tertiary"
      />
      {value ? null : (
        <kbd class="pointer-events-none absolute right-2 rounded-badge border border-border px-1 text-caption text-text-tertiary">
          /
        </kbd>
      )}
    </div>
  );
}

/**
 * Render the sections a query names.
 *
 * Plain containment over the section's own vocabulary — `toLowerCase().includes()`.
 * Fuzzy search would need a dependency and a ranking model to answer a question this
 * page never gets asked: the query is almost always the label of the one setting the
 * user is looking for, which is an exact substring of that section's index.
 */
function SectionList() {
  const needle = query.value.trim().toLowerCase();
  const matched = SECTIONS.filter((entry) => `${entry.title} ${entry.terms}`.toLowerCase().includes(needle));

  return (
    <>
      {matched.map((entry) => (
        <Section key={entry.title} title={entry.title} status={entry.status()}>
          {entry.body()}
        </Section>
      ))}
      {matched.length ? null : <p class="text-body text-text-muted">No settings match “{needle}”.</p>}
    </>
  );
}

export function OptionsPage() {
  const searchRef = useRef<HTMLInputElement | null>(null);

  // `/` focuses search wherever focus is, except inside a text field (spec §10).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div class="flex min-h-screen flex-col bg-raised text-text">
      <Toolbar sticky leading={<Logo />} title="Qwin" caption={loaded.value ? "Settings" : "Loading..."}>
        <SearchField inputRef={searchRef} />
      </Toolbar>

      <main class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6">
        <SectionList />
      </main>
    </div>
  );
}
