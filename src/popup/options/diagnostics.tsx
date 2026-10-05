/**
 * The two read-mostly groups: the native-helper diagnostic and the housekeeping section.
 *
 * Split out of `sections.tsx` because they are what a user opens this page to *inspect*,
 * while the rest are what they open it to *change*. The diagnostics are also the two
 * sections that are entirely read-only apart from two buttons, which makes them a very
 * different density from a card of controls.
 */
import { Saved } from "./Saved.js";
import {
  clearHistory,
  copyInstallCommand,
  filterLists,
  HELPER_DEPENDENCIES,
  helper,
  historyCount,
  INSTALL_COMMAND,
  isMissing,
  recheckHelper,
} from "./state.js";
import { StatusDot, type StatusDotState } from "../../ui/Icon.js";
import { Button } from "../../ui/components/Button.js";
import { isUnknown } from "../../shared/helper_dependencies.js";

/** The three things a tool's chip can honestly say. See `CHIP_STATE`. */
type DependencyState = "installed" | "missing" | "unknown";

/**
 * Dot + screen-reader wording per state, in one place so the two cannot disagree.
 *
 * `unknown` is the third state the reported bug was missing: `isMissing` reads an absent
 * key as missing and `dependencies` is `{}` before a probe answers, so a two-state chip
 * labelled all five tools "missing" for as long as the cold ping took. See
 * native-helper-status-spec.md §2.2, §5 Step 4.
 */
const CHIP_STATE: Record<DependencyState, { dot: StatusDotState; label: string }> = {
  installed: { dot: "success", label: "installed" },
  missing: { dot: "critical", label: "missing" },
  unknown: { dot: "neutral", label: "not checked yet" },
};

/**
 * One tool, as a chip with a state dot (spec §8).
 *
 * The dot is `StatusDot` — the same component the popup header uses, so it is literally
 * the same element — and it carries a screen-reader label naming the tool and its state
 * ("yt-dlp — installed"). The check/cross text characters this replaces carried neither,
 * and rendered at visibly different weights on different platforms (spec §1.5).
 *
 * The state is expressed *only* by the dot: adding a second coloured glyph beside it
 * would make the same fact legible twice and disagreement-prone.
 */
function DependencyChip({ name, required, state }: { name: string; required: boolean; state: DependencyState }) {
  const chip = CHIP_STATE[state];
  return (
    <li class="flex items-center gap-2 rounded-badge bg-raised py-1 pl-2 pr-3">
      <StatusDot state={chip.dot} label={`${name} — ${chip.label}`} />
      <span class="text-body text-text">{name}</span>
      <span class="vibrancy-tertiary text-caption text-text-tertiary">{required ? "Required" : "Optional"}</span>
    </li>
  );
}

export function HelperSection() {
  const status = helper.value;
  const unknown = isUnknown(status);
  // Empty while unknown, which is what suppresses the install hint: nothing is known to
  // be missing, and telling the user to install tools then is the false alarm itself.
  const missing = unknown ? [] : HELPER_DEPENDENCIES.filter((dep) => isMissing(status.dependencies, dep.key));

  return (
    <>
      <p class="text-body text-text">
        {unknown
          ? "Unknown — helper not reachable yet. The tool states below are unconfirmed until a check answers."
          : status.connected
            ? `Connected${status.version ? ` · helper ${status.version}` : ""}.`
            : "Not connected. Downloads need the native helper."}
      </p>
      {/* A red line here would alarm over a probe that may still be in flight; the text
          still explains *why* it is unknown, just without the failure styling. */}
      {status.error ? (
        <p class={`text-caption ${unknown ? "text-text-muted" : "text-critical"}`}>{status.error}</p>
      ) : null}

      <ul class="flex flex-wrap gap-2">
        {HELPER_DEPENDENCIES.map((dep) => (
          <DependencyChip
            key={dep.key}
            name={dep.name}
            required={dep.required}
            state={unknown ? "unknown" : isMissing(status.dependencies, dep.key) ? "missing" : "installed"}
          />
        ))}
      </ul>

      {missing.length ? (
        <p class="text-caption text-text-muted">
          Run <code class="rounded-badge bg-raised px-1 text-text">{INSTALL_COMMAND}</code> from the Qwin project
          directory to install what is missing, then reload the extension.
        </p>
      ) : null}

      <div class="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => void recheckHelper()}>
          Check again
        </Button>
        <Button variant="plain" onClick={() => void copyInstallCommand()}>
          Copy install command
        </Button>
        <Saved field="helper" />
        <Saved field="install" />
      </div>
    </>
  );
}

/** Cache age of one filter list, in the words the rest of the page uses. */
function cachedLabel(fetchedAt: number): string {
  if (!fetchedAt) {
    return "not fetched yet";
  }
  const days = Math.max(0, Math.round((Date.now() - fetchedAt) / 86_400_000));
  return days ? `cached ${days} day${days === 1 ? "" : "s"} ago` : "cached today";
}

export function AdvancedSection() {
  return (
    <>
      <div class="flex flex-col gap-2">
        <h3 class="text-row text-text">Filter list sources</h3>
        <p class="text-caption text-text-muted">
          A fixed set of block rules, refreshed automatically in the background. There is nothing to enable or disable.
        </p>
        <ul class="flex flex-col gap-2">
          {filterLists.value.map((list) => (
            <li key={list.key} class="flex flex-wrap items-baseline justify-between gap-2">
              <span class="text-body text-text">{list.label}</span>
              <span class="nums text-caption text-text-muted">
                {list.expectedSize} · every {list.refreshDays} day{list.refreshDays === 1 ? "" : "s"} ·{" "}
                {cachedLabel(list.fetchedAt)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span class="nums text-body text-text-muted">{historyCount.value} entries synced</span>
        <Button variant="plain" onClick={() => void clearHistory()}>
          Clear synced history
        </Button>
        <Saved field="history" />
      </div>
    </>
  );
}
