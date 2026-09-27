/** The pieces every screen is built from: its header, sections and panels. */
import * as stylex from "@stylexjs/stylex";
import { colors, radii, shadows, space, text, weights } from "@via/ui/tokens.stylex";
import { motion } from "motion/react";
import type { ReactNode } from "react";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: "32px",
    width: "100%",
    maxWidth: "1080px",
    marginInline: "auto",
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.s4,
  },
  heading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: "22px",
    lineHeight: 1.2,
    letterSpacing: "-0.01em",
    fontVariationSettings: weights.bold,
    color: colors.foreground,
  },
  description: {
    maxWidth: "60ch",
    margin: 0,
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s3,
  },
  sectionTitle: {
    margin: 0,
    fontSize: text.subtitle,
    fontVariationSettings: weights.semibold,
    color: colors.foreground,
  },
  sectionAside: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  panel: {
    boxSizing: "border-box",
    minWidth: 0,
    padding: space.s4,
    borderRadius: radii.container,
    backgroundColor: colors.surface3,
    boxShadow: shadows.surface3,
  },
  flush: {
    paddingBlock: space.s1,
    paddingInline: space.s2,
  },
});

export function Page({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", duration: 0.3, bounce: 0 }}
      {...stylex.props(styles.page)}
    >
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.heading)}>
          <h1 {...stylex.props(styles.title)}>{title}</h1>
          {description !== undefined && <p {...stylex.props(styles.description)}>{description}</p>}
        </div>
        {actions !== undefined && <div {...stylex.props(styles.actions)}>{actions}</div>}
      </header>
      {children}
    </motion.div>
  );
}

export function Section({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section aria-label={title} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHeader)}>
        <h2 {...stylex.props(styles.sectionTitle)}>{title}</h2>
        {aside !== undefined && <span {...stylex.props(styles.sectionAside)}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A raised surface; `flush` for a table that brings its own cell padding. */
export function Panel({
  flush = false,
  xstyle,
  children,
}: {
  readonly flush?: boolean;
  readonly xstyle?: stylex.StyleXStyles;
  readonly children?: ReactNode;
}) {
  return <div {...stylex.props(styles.panel, flush && styles.flush, xstyle)}>{children}</div>;
}
