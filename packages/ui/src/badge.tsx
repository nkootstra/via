/**
 * Badge, ported from Fluid Functionalism's badge (MIT, see NOTICE): a solid
 * tint of its colour, or an outlined label led by a coloured dot.
 */
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";
import { colors, radii, space, text, weights } from "./tokens.stylex.ts";

export type BadgeColor = "gray" | "green" | "amber" | "red" | "blue";

export interface BadgeProps extends Omit<ComponentProps<"span">, "className" | "style" | "color"> {
  readonly color?: BadgeColor;
  readonly variant?: "solid" | "dot";
}

const styles = stylex.create({
  root: {
    display: "inline-flex",
    alignItems: "center",
    height: "24px",
    paddingInline: space.s2_5,
    gap: space.s1_5,
    borderRadius: radii.item,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    whiteSpace: "nowrap",
    color: colors.foreground,
  },
  dotVariant: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  dot: {
    flexShrink: 0,
    width: "7px",
    height: "7px",
    borderRadius: radii.full,
  },
});

// A solid badge is its colour at 15% over the background; gray uses the
// accent surface instead.
const solid = stylex.create({
  gray: { backgroundColor: colors.accent },
  green: { backgroundColor: `color-mix(in srgb, #22c55e 15%, ${colors.background})` },
  amber: { backgroundColor: `color-mix(in srgb, #f59e0b 15%, ${colors.background})` },
  red: { backgroundColor: `color-mix(in srgb, #ef4444 15%, ${colors.background})` },
  blue: { backgroundColor: `color-mix(in srgb, #3b82f6 15%, ${colors.background})` },
});

const dots = stylex.create({
  gray: { backgroundColor: colors.mutedForeground },
  green: { backgroundColor: "#22c55e" },
  amber: { backgroundColor: "#f59e0b" },
  red: { backgroundColor: "#ef4444" },
  blue: { backgroundColor: "#3b82f6" },
});

export function Badge({ color = "gray", variant = "solid", children, ...props }: BadgeProps) {
  const dot = variant === "dot";

  return (
    <span {...props} {...stylex.props(styles.root, dot ? styles.dotVariant : solid[color])}>
      {dot && <span aria-hidden="true" {...stylex.props(styles.dot, dots[color])} />}
      {children}
    </span>
  );
}
