/**
 * What a view shows before it has data (Skeleton) and when it has none
 * (EmptyState), in Fluid Functionalism's surfaces (MIT, see NOTICE).
 */
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { colors, radii, space, text, weights } from "./tokens.stylex.ts";

const shimmer = stylex.keyframes({
  "0%": { backgroundPosition: "100% 0" },
  "100%": { backgroundPosition: "-100% 0" },
});

const styles = stylex.create({
  skeleton: {
    display: "block",
    borderRadius: radii.item,
    backgroundImage: `linear-gradient(90deg, ${colors.muted} 25%, ${colors.hover} 50%, ${colors.muted} 75%)`,
    backgroundColor: colors.muted,
    backgroundSize: "200% 100%",
    animationName: shimmer,
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
    fontSize: text.subtitle,
    fontVariationSettings: weights.semibold,
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
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <section aria-label={title} {...stylex.props(styles.empty)}>
      {icon !== undefined && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          {icon}
        </span>
      )}
      <h3 {...stylex.props(styles.title)}>{title}</h3>
      {description !== undefined && <p {...stylex.props(styles.description)}>{description}</p>}
      {action !== undefined && <div {...stylex.props(styles.action)}>{action}</div>}
    </section>
  );
}
