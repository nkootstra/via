import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { formatDate, formatTimestamp } from "../lib/time.ts";

const styles = stylex.create({
  day: {
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
});

/**
 * When something happened, as a table shows it: its day, or `children` such
 * as "3 min ago"; the full time on hover.
 */
export function Day({ at, children }: { readonly at: string; readonly children?: ReactNode }) {
  return (
    <time dateTime={at} title={formatTimestamp(at)} {...stylex.props(styles.day)}>
      {children ?? formatDate(at)}
    </time>
  );
}
