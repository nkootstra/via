/**
 * Badge, ported from Fluid Functionalism's badge (MIT, see NOTICE): a solid
 * tint of its colour, or an outlined label led by a coloured dot.
 */
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps } from "react";
import { colors, radii, space, text, fontWeights, weights } from "./tokens.stylex.ts";

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
    maxWidth: "100%",
    paddingInline: space.s2_5,
    gap: space.s1_5,
    borderRadius: radii.item,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    whiteSpace: "nowrap",
    color: colors.foreground,
  },
  // A long label, such as a plan's name, ends in an ellipsis within its room.
  label: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
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

// A solid badge is its colour's subtle tint, the same a Callout uses; gray
// uses the accent surface instead.
const solid = stylex.create({
  gray: { backgroundColor: colors.accent },
  green: { backgroundColor: colors.successSubtle },
  amber: { backgroundColor: colors.warningSubtle },
  red: { backgroundColor: colors.destructiveSurface },
  blue: { backgroundColor: colors.infoSubtle },
});

const dots = stylex.create({
  gray: { backgroundColor: colors.mutedForeground },
  green: { backgroundColor: colors.success },
  amber: { backgroundColor: colors.warning },
  red: { backgroundColor: colors.destructive },
  blue: { backgroundColor: colors.info },
});

export function Badge({ color = "gray", variant = "solid", children, ...props }: BadgeProps) {
  const dot = variant === "dot";

  return (
    <span {...props} {...stylex.props(styles.root, dot ? styles.dotVariant : solid[color])}>
      {dot && <span aria-hidden="true" {...stylex.props(styles.dot, dots[color])} />}
      <span {...stylex.props(styles.label)}>{children}</span>
    </span>
  );
}
