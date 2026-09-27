/** A focused card in the middle of the page, for signing in and for errors. */
import * as stylex from "@stylexjs/stylex";
import { colors, fonts, shadows, space, text } from "@via/ui/tokens.stylex";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Mark } from "./icons.tsx";

const styles = stylex.create({
  page: {
    position: "relative",
    display: "grid",
    placeItems: "center",
    minHeight: "100dvh",
    paddingInline: space.s4,
    boxSizing: "border-box",
    overflow: "hidden",
    fontFamily: fonts.sans,
    fontSize: text.body,
    color: colors.foreground,
    backgroundColor: colors.background,
  },
  // A soft light from above and a faint dot grid, fading out downwards.
  glow: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundImage: `radial-gradient(ellipse 60% 45% at 50% 0%, color-mix(in oklab, ${colors.foreground} 7%, transparent), transparent 70%), radial-gradient(color-mix(in oklab, ${colors.foreground} 14%, transparent) 1px, transparent 1px)`,
    backgroundSize: "100% 100%, 22px 22px",
    maskImage: "linear-gradient(to bottom, black 0%, transparent 75%)",
  },
  column: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "28px",
    width: "100%",
    maxWidth: "380px",
    paddingBlock: "48px",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    color: colors.foreground,
    fontSize: "20px",
    letterSpacing: "-0.02em",
    fontVariationSettings: "'wght' 650",
  },
  card: {
    boxSizing: "border-box",
    width: "100%",
    padding: "28px",
    borderRadius: "16px",
    backgroundColor: colors.surface5,
    boxShadow: shadows.surface5,
  },
  footnote: {
    maxWidth: "34ch",
    margin: 0,
    fontSize: text.caption,
    lineHeight: 1.5,
    textAlign: "center",
    color: colors.mutedForeground,
  },
});

export function Centered({
  footnote,
  children,
}: {
  readonly footnote?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <main {...stylex.props(styles.page)}>
      <div aria-hidden="true" {...stylex.props(styles.glow)} />
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.brand)}>
          <Mark size={30} />
          via
        </div>
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", duration: 0.4, bounce: 0.1 }}
          {...stylex.props(styles.card)}
        >
          {children}
        </motion.div>
        {footnote !== undefined && <p {...stylex.props(styles.footnote)}>{footnote}</p>}
      </div>
    </main>
  );
}
