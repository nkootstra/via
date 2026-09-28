/**
 * Meter: how much of a limit is used, as a labelled bar in Fluid
 * Functionalism's quiet style (MIT, see NOTICE). The fill springs to its
 * value and turns amber, then red, as the limit nears. Base UI gives it the
 * `meter` role, named by its label, with the percentage as its value text.
 */
import { Meter as BaseMeter } from "@base-ui/react/meter";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { colors, durations, radii, space, text, fontWeights, weights } from "./tokens.stylex.ts";

const forced = "@media (forced-colors: active)";

const styles = stylex.create({
  root: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    alignItems: "baseline",
    rowGap: space.s1_5,
    columnGap: space.s2,
    minWidth: 0,
  },
  label: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  value: {
    fontSize: text.caption,
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.mutedForeground,
  },
  track: {
    gridColumn: "1 / -1",
    position: "relative",
    height: "6px",
    overflow: "hidden",
    borderRadius: radii.full,
    backgroundColor: colors.muted,
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
    // Forced colours drop the shadow; a border keeps the track's edge.
    borderWidth: { default: 0, [forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    forcedColorAdjust: { default: null, [forced]: "none" },
  },
  // The fill is the track's full width and slides in from the left, clipped
  // by the track, so its rounded cap never squashes as a scale would.
  fill: {
    position: "absolute",
    inset: 0,
    borderRadius: radii.full,
    transitionProperty: "background-color",
    transitionDuration: durations.moderate,
  },
  detail: {
    gridColumn: "1 / -1",
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
});

// The fill is a mark, not text, so full takes the solid red, not the text red.
const levels = stylex.create({
  low: { backgroundColor: { default: colors.success, [forced]: "Highlight" } },
  high: { backgroundColor: { default: colors.warning, [forced]: "Highlight" } },
  full: { backgroundColor: { default: colors.destructiveSolid, [forced]: "Highlight" } },
});

const fillSpring = { type: "spring", duration: 0.3, bounce: 0 } as const;

const percentText = (percent: number) => `${Math.round(percent)}%`;

const level = (percent: number) => (percent >= 90 ? "full" : percent >= 70 ? "high" : "low");

export interface MeterProps {
  readonly label: string;
  /** Percent used: the bar fills to 100, the text shows it past that too. */
  readonly value: number;
  /** A line under the bar, such as when the limit resets. */
  readonly detail?: ReactNode;
}

export function Meter({ label, value, detail }: MeterProps) {
  // Only the bar stops at the limit; the text says the real figure, past it too.
  const percent = Math.min(100, Math.max(0, value));

  return (
    <BaseMeter.Root
      value={percent}
      getAriaValueText={() => percentText(value)}
      {...stylex.props(styles.root)}
    >
      <BaseMeter.Label title={label} {...stylex.props(styles.label)}>
        {label}
      </BaseMeter.Label>
      <BaseMeter.Value {...stylex.props(styles.value)}>{() => percentText(value)}</BaseMeter.Value>
      <BaseMeter.Track {...stylex.props(styles.track)}>
        <motion.span
          aria-hidden="true"
          initial={{ transform: "translateX(-100%)" }}
          animate={{ transform: `translateX(${percent - 100}%)` }}
          transition={fillSpring}
          {...stylex.props(styles.fill, levels[level(percent)])}
        />
      </BaseMeter.Track>
      {detail !== undefined && <span {...stylex.props(styles.detail)}>{detail}</span>}
    </BaseMeter.Root>
  );
}
