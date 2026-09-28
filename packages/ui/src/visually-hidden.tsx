/** Text for assistive tech alone: read out and part of names, but not drawn. */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

const styles = stylex.create({
  root: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** The shared style, for an element that must be something other than a span. */
export const visuallyHidden = styles.root;

export function VisuallyHidden({ children }: { readonly children?: ReactNode }) {
  return <span {...stylex.props(styles.root)}>{children}</span>;
}
