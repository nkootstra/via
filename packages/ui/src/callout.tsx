/**
 * Callout: a short message set apart in its tone's colour, such as a caution
 * above a form. It is a note unless the caller says otherwise; a callout that
 * must interrupt, such as a failure, takes `role="alert"`.
 */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { colors, radii, space, text } from "./tokens.stylex.ts";

export type CalloutTone = "warning" | "danger" | "info";

const styles = stylex.create({
  root: {
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    // Invisible, until forced colours draw it as the callout's edge.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radii.item,
    fontSize: text.caption,
    lineHeight: 1.45,
    overflowWrap: "anywhere",
    color: colors.foreground,
  },
});

// The tone's subtle tint, with a firmer hairline of it inside the edge.
const ring = (color: string) => `inset 0 0 0 1px color-mix(in srgb, ${color} 28%, transparent)`;

const tones = stylex.create({
  warning: { backgroundColor: colors.warningSubtle, boxShadow: ring(colors.warning) },
  danger: { backgroundColor: colors.destructiveSurface, boxShadow: ring(colors.destructive) },
  info: { backgroundColor: colors.infoSubtle, boxShadow: ring(colors.info) },
});

export interface CalloutProps {
  readonly tone: CalloutTone;
  /** `note` by default; `alert` for one that must be heard at once. */
  readonly role?: "note" | "alert" | "status";
  readonly children: ReactNode;
}

export function Callout({ tone: which, role = "note", children }: CalloutProps) {
  return (
    <div role={role} {...stylex.props(styles.root, tones[which])}>
      {children}
    </div>
  );
}
