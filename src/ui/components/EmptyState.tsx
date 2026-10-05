import type { IconName } from "../Icon.js";
import { Icon } from "../Icon.js";
import { Button } from "./Button.js";

export type EmptyStateTone = "neutral" | "caution" | "critical";

export interface EmptyStateProps {
  /** The glyph. One icon set, no emoji (spec §4.4). */
  icon: IconName;
  /** What happened, in the user's terms: "No video on this page". */
  headline: string;
  /** One line of why. Never a paragraph — this is not where the explanation lives. */
  body?: string;
  /** Exactly one next action (spec §6.10, D13). */
  action?: { label: string; onClick(): void };
  tone?: EmptyStateTone;
}

const TONES: Record<EmptyStateTone, string> = {
  neutral: "bg-raised text-text-tertiary",
  caution: "bg-caution/10 text-caution",
  critical: "bg-critical/10 text-critical",
};

/**
 * The four designed states per view (spec §6.10, D13): a glyph, a specific headline,
 * one line of explanation and one real action.
 *
 * "No state ships as a bare centered sentence" — the reason this takes an `action` with
 * a handler rather than a link-shaped label is that a control that does nothing is the
 * exact failure being replaced (`"Scanning for videos..."`, `"No downloads yet."`). A
 * state with genuinely no next step omits `action` and renders no button at all.
 *
 * The glyph sits in a 64px well with a 32px stroke icon inside it: a 64px *stroke* at
 * `stroke-width: 1.6` would be a hairline across a hand's width of canvas. The 64px is
 * the glyph's allotted box, which is what the spec is fixing.
 */
export function EmptyState({ icon, headline, body, action, tone = "neutral" }: EmptyStateProps) {
  return (
    <div class="flex flex-col items-center gap-4 px-6 py-8 text-center" role="status">
      <span class={`flex size-16 items-center justify-center rounded-card ${TONES[tone]}`} aria-hidden="true">
        <Icon name={icon} size={32} strokeWidth={1.4} />
      </span>
      <div class="flex flex-col gap-1">
        <p class="text-row text-text">{headline}</p>
        {body ? <p class="text-body text-text-muted">{body}</p> : null}
      </div>
      {action ? (
        <Button size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
