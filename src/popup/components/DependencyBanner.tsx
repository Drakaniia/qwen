import { animate } from "motion";
import { useEffect, useRef, useState } from "preact/hooks";

import { Button } from "../../ui/components/Button.js";
import { Icon } from "../../ui/Icon.js";
import { prefersReducedMotion, springs } from "../../ui/motion.js";
import { copyInstallCommand, INSTALL_COMMAND } from "../popup_helpers.js";
import { dependencyBanner, setNotice } from "../state/app.js";

/**
 * The dependency banner (spec §6.3).
 *
 * Replaces the hardcoded `bg-amber-50` / `text-amber-700` block. A `caution`-tinted
 * translucent sheet, the missing tools as chips, one primary action and one text action.
 *
 * ## Why a spring and not a `max-height` transition
 *
 * §6.3, verbatim: "Expands with a spring, not a `max-height` transition — `max-height`
 * cannot be interrupted and was the reason the state machine had to live in CSS at all."
 *
 * The old implementation could not be interrupted in two senses: the CSS transition
 * restarted its easing from the *computed* max-height on every toggle, so a mid-flight
 * reversal visibly jumped; and because the collapsed height and its transition were one
 * state machine in `styles/quality-dialog.css`, the whole expand/collapse decision had
 * to live in a stylesheet. `motion`'s `animate()` on `height: "auto"` reads the live
 * presentation value as its first keyframe, so a reversal mid-spring continues from
 * where it looks like it is instead of snapping.
 *
 * Under `prefers-reduced-motion` there is no transform and no overshoot to reduce, so
 * the height change becomes instant rather than being faked with a fade — a fade of a
 * growing panel is exactly the "fade + slide" §4.5 rules out.
 */
export function DependencyBanner() {
  const banner = dependencyBanner.value;
  // Open on arrival: a banner the user has to expand to find out what is broken is a
  // banner that gets missed. The toggle is still there for the dismiss-and-read case.
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    if (prefersReducedMotion()) {
      body.style.height = open ? "auto" : "0px";
      body.style.opacity = open ? "1" : "0";
      return;
    }
    const controls = animate(
      body,
      { height: open ? "auto" : "0px", opacity: open ? 1 : 0 },
      { ...springs.material, type: "spring" },
    );
    return () => controls.stop();
  }, [open, banner !== null]);

  if (!banner) {
    return null;
  }

  const missing = banner.missing;
  const noun = missing.length === 1 ? "tool" : "tools";

  async function copy() {
    if (await copyInstallCommand()) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      setNotice(`Copied ${INSTALL_COMMAND}. Run it from the Qwin project directory.`);
    } else {
      setNotice(`Could not copy. Run ${INSTALL_COMMAND} from the Qwin project directory.`, true);
    }
  }

  return (
    <section class="material-sheet border-b border-separator px-4 py-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="qwin-dep-banner-body"
        onClick={() => setOpen(!open)}
        class="pressable flex w-full items-center gap-2 text-left"
      >
        <span class="shrink-0 text-caution">
          <Icon name="exclamationmark.triangle" size={16} />
        </span>
        <span class="min-w-0 flex-1 text-body font-medium text-text">
          {missing.length} download {noun} missing
        </span>
        <span class={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}>
          <Icon name="chevron.right" size={14} />
        </span>
      </button>

      <div
        ref={bodyRef}
        id="qwin-dep-banner-body"
        aria-hidden={!open}
        class="overflow-hidden"
        style={{ height: open ? "auto" : "0px" }}
      >
        <div class="flex flex-col gap-3 pt-3">
          <ul class="flex flex-wrap gap-2" aria-label={`Missing download ${noun}`}>
            {missing.map((dep) => (
              <li
                key={dep.key}
                title={dep.purpose}
                class="rounded-badge bg-caution/12 px-2 py-1 text-caption font-medium text-caution"
              >
                {dep.name}
              </li>
            ))}
          </ul>

          <p class="text-caption text-text-muted">
            Run <code class="rounded-badge bg-raised px-1 text-numeric">{INSTALL_COMMAND}</code> from the Qwin project
            directory to install them.
          </p>

          <div class="flex items-center gap-3">
            <Button size="sm" variant="primary" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy install command"}
            </Button>
            <a href="./options.html" target="_blank" class="text-caption text-accent hover:underline">
              Open Options
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
