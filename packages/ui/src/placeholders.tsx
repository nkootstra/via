/**
 * What a view shows before it has data (Skeleton) and when it has none
 * (EmptyState), in Fluid Functionalism's surfaces (MIT, see NOTICE).
 */
import * as stylex from "@stylexjs/stylex";
import { useId, type ReactNode } from "react";
import { colors, radii, space, text, fontWeights, weights } from "./tokens.stylex.ts";

// A pulse of opacity, which the compositor runs, rather than a moving gradient
// that repaints every frame.
const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 1 },
  "50%": { opacity: 0.55 },
});

const styles = stylex.create({
  skeleton: {
    display: "block",
    borderRadius: radii.item,
    backgroundColor: colors.muted,
    animationName: pulse,
    animationDuration: "1.6s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
    "@media (prefers-reduced-motion: reduce)": { animationName: "none" },
  },
  size: (width: string, height: string) => ({ width, height }),
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s2,
    paddingBlock: "48px",
    paddingInline: space.s6,
    borderRadius: radii.container,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    textAlign: "center",
  },
  compact: { paddingBlock: space.s6 },
  icon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "40px",
    height: "40px",
    marginBottom: space.s1,
    borderRadius: radii.container,
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
  },
  title: {
    margin: 0,
    overflowWrap: "anywhere",
    fontSize: text.subtitle,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  description: {
    maxWidth: "36ch",
    margin: 0,
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  action: { marginTop: space.s2 },
});

export interface SkeletonProps {
  /** CSS width; defaults to the container's. */
  readonly width?: string;
  readonly height?: string;
}

/** A shimmering stand-in for content that is loading; hidden from assistive tech. */
export function Skeleton({ width = "100%", height = "14px" }: SkeletonProps) {
  return <span aria-hidden="true" {...stylex.props(styles.skeleton, styles.size(width, height))} />;
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  /** What to do about it: usually one Button. */
  readonly action?: ReactNode;
  /** The title's heading level, one below the heading it sits under. */
  readonly headingLevel?: 2 | 3;
  /** Less room above and below, for an empty state inside a section of a page. */
  readonly compact?: boolean;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  headingLevel = 3,
  compact = false,
}: EmptyStateProps) {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section aria-labelledby={id} {...stylex.props(styles.empty, compact && styles.compact)}>
      {icon !== undefined && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          {icon}
        </span>
      )}
      <Heading id={id} {...stylex.props(styles.title)}>
        {title}
      </Heading>
      {description !== undefined && <p {...stylex.props(styles.description)}>{description}</p>}
      {action !== undefined && <div {...stylex.props(styles.action)}>{action}</div>}
    </section>
  );
}
