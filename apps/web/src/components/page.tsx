/** The pieces every screen is built from: its header, sections and panels. */
import * as stylex from "@stylexjs/stylex";
import { colors, radii, shadows, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { motion } from "motion/react";
import { createContext, use, useId, useRef, type ReactNode, type RefObject } from "react";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: space.s8,
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
    // It takes focus only from code, when what had it is gone; no ring for that.
    outline: "none",
    fontSize: text.display,
    lineHeight: 1.2,
    textWrap: "balance",
    letterSpacing: "-0.02em",
    fontVariationSettings: weights.bold,
    fontWeight: fontWeights.bold,
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
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s3,
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    margin: 0,
    fontSize: text.subtitle,
    textWrap: "balance",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  sectionAside: {
    whiteSpace: "nowrap",
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
  // A table's cells bring 12px of their own, so its text lines up 16px in, as in any panel.
  flush: {
    paddingBlock: space.s1,
    paddingInline: space.s1,
  },
});

const PageHeading = createContext<RefObject<HTMLHeadingElement | null>>({ current: null });

/**
 * The page's heading, for focus to land on when what had it is gone: a
 * dialog's `finalFocus` once the row it removed took its trigger along.
 */
export const usePageHeading = () => use(PageHeading);

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
  const heading = useRef<HTMLHeadingElement>(null);

  return (
    // A fade only: the page arrives on every navigation, so nothing travels.
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      {...stylex.props(styles.page)}
    >
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.heading)}>
          <h1 ref={heading} tabIndex={-1} {...stylex.props(styles.title)}>
            {title}
          </h1>
          {description !== undefined && <p {...stylex.props(styles.description)}>{description}</p>}
        </div>
        {actions !== undefined && <div {...stylex.props(styles.actions)}>{actions}</div>}
      </header>
      <PageHeading value={heading}>{children}</PageHeading>
    </motion.div>
  );
}

export function Section({
  title,
  icon,
  aside,
  children,
}: {
  readonly title: string;
  /** A mark shown before the title, such as a provider's logo. */
  readonly icon?: ReactNode;
  readonly aside?: ReactNode;
  readonly children?: ReactNode;
}) {
  const id = useId();

  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHeader)}>
        <h2 id={id} {...stylex.props(styles.sectionTitle)}>
          {icon}
          {title}
        </h2>
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
