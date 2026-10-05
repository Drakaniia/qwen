import { Segmented } from "./Segmented.js";

const MB = 1024 * 1024;

/**
 * The four stops of spec §6.7, `null` first: `Any` is not "0 MB" — it is the absence of
 * a filter, and a candidate of unknown size must pass it.
 */
const STOPS: readonly (number | null)[] = [null, MB, 10 * MB, 50 * MB];

const SEGMENTS = [
  { value: "any", label: "Any" },
  { value: "s1", label: "≥ 1 MB" },
  { value: "s10", label: "≥ 10 MB" },
  { value: "s50", label: "≥ 50 MB" },
] as const;

export interface MeterProps {
  /** Bytes, or `null`/`undefined` for `Any`. */
  value: number | null;
  onChange(bytes: number | null): void;
  ariaLabel?: string;
  class?: string;
}

/**
 * The min-size threshold filter (spec §6.7, D8), as a four-stop stepped control over
 * `DetectedVideo.sizeBytes` — which already crosses the wire (spec §3.1), so this needs
 * no backend change at all.
 *
 * Deliberately a `Segmented` rather than a continuous slider: four stops on a log scale
 * is four positions, and a drag control over a log axis is harder to aim at than four
 * labelled targets and tells the user less about what they picked.
 *
 * This reports the chosen threshold and nothing else. The consequence line —
 * "12 detected · 4 hidden below 1 MB" — belongs to the caller, because only the caller
 * knows the candidate list, and recomputing it here would mean handing this component
 * the whole array to answer a question about one number.
 */
export function Meter({ value, onChange, ariaLabel = "Minimum size", class: className }: MeterProps) {
  const index = STOPS.findIndex((stop) => stop === (value ?? null));

  return (
    <Segmented
      size="sm"
      ariaLabel={ariaLabel}
      class={className}
      segments={SEGMENTS}
      // An unrecognised threshold would leave nothing selected, which reads as "Any"
      // while filtering — so it falls back to `Any` rather than lying.
      value={SEGMENTS[index < 0 ? 0 : index].value}
      onChange={(next) => onChange(STOPS[SEGMENTS.findIndex((segment) => segment.value === next)])}
    />
  );
}
