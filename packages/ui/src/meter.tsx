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
import { spring } from "./springs.ts";
import { colors, radii, space, text, weights } from "./tokens.stylex.ts";

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
    color: colors.foreground,
  },
  value: {
    fontSize: text.caption,
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.medium,
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
  },
  fill: {
    position: "absolute",
    inset: 0,
    borderRadius: radii.full,
    transformOrigin: "left",
  },
  detail: {
    gridColumn: "1 / -1",
    fontSize: text.compact,
    color: colors.mutedForeground,
  },
});

const levels = stylex.create({
  low: { backgroundColor: "#22c55e" },
  high: { backgroundColor: "#f59e0b" },
  full: { backgroundColor: "#ef4444" },
});

const percentText = (percent: number) => `${Math.round(percent)}%`;

const level = (percent: number) => (percent >= 90 ? "full" : percent >= 70 ? "high" : "low");

export interface MeterProps {
  readonly label: string;
  /** Percent used, 0–100. */
  readonly value: number;
  /** A line under the bar, such as when the limit resets. */
  readonly detail?: ReactNode;
}

export function Meter({ label, value, detail }: MeterProps) {
  const percent = Math.min(100, Math.max(0, value));

  return (
    <BaseMeter.Root
      value={percent}
      getAriaValueText={(_formatted, used) => percentText(used)}
      {...stylex.props(styles.root)}
    >
      <BaseMeter.Label {...stylex.props(styles.label)}>{label}</BaseMeter.Label>
      <BaseMeter.Value {...stylex.props(styles.value)}>
        {(_formatted, used) => percentText(used)}
      </BaseMeter.Value>
      <BaseMeter.Track {...stylex.props(styles.track)}>
        <motion.span
          aria-hidden="true"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: percent / 100 }}
          transition={spring.slow}
          {...stylex.props(styles.fill, levels[level(percent)])}
        />
      </BaseMeter.Track>
      {detail !== undefined && <span {...stylex.props(styles.detail)}>{detail}</span>}
    </BaseMeter.Root>
  );
}
