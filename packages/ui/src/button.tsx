/**
 * Button, ported from Fluid Functionalism's Base UI button (MIT, see NOTICE).
 *
 * The press effect: the fill sits 1px inside the button and a same-colour
 * spread shadow fills it back out. Pressing collapses the spread, so the
 * surface shrinks by exactly 1px a side at any width, where a scale would
 * warp a wide button.
 */
import { Button as BaseButton } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";
import { colors, durations, radii, space, text } from "./tokens.stylex.ts";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "ghost";

export type ButtonSize = "default" | "compact" | "icon" | "icon-compact";

export interface ButtonProps extends Omit<
  ComponentProps<typeof BaseButton>,
  "className" | "style" | "render"
> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Disables the button and swaps the label for a spinner, keeping its width and name. */
  readonly loading?: boolean;
  /** Layout from the caller: margins, position. */
  readonly xstyle?: stylex.StyleXStyles;
  readonly children?: ReactNode;
}

// Fills are opaque mixes rather than alpha, so a fill and its spread ring
// never show a seam.
const primaryHover = `color-mix(in oklab, ${colors.foreground} 90%, ${colors.background})`;

const primaryPress = `color-mix(in oklab, ${colors.foreground} 80%, ${colors.background})`;

const secondaryHover = `color-mix(in oklab, ${colors.accent} 80%, ${colors.background})`;

const spinnerMove = stylex.keyframes({ to: { strokeDashoffset: -100 } });

const spinnerDash = stylex.keyframes({
  "0%, 100%": { strokeDasharray: "15 85" },
  "50%": { strokeDasharray: "40 60" },
});

const styles = stylex.create({
  root: {
    position: "relative",
    isolation: "isolate",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderWidth: 0,
    borderRadius: radii.item,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    cursor: "pointer",
    outline: "none",
    transitionProperty: "color",
    transitionDuration: durations.fast,
    boxShadow: {
      default: null,
      ":focus-visible": `0 0 0 1px ${colors.focusRing}`,
    },
  },
  disabled: {
    opacity: 0.5,
    pointerEvents: "none",
  },
  default: {
    height: space.control,
    paddingInline: space.s4,
    gap: space.s1_5,
    fontSize: text.body,
  },
  compact: {
    height: space.controlCompact,
    paddingInline: space.s3,
    gap: space.s1,
    fontSize: text.caption,
  },
  icon: {
    width: space.control,
    height: space.control,
    padding: 0,
  },
  "icon-compact": {
    width: space.controlCompact,
    height: space.controlCompact,
    padding: 0,
  },
  primary: { color: colors.background },
  secondary: { color: colors.foreground },
  tertiary: { color: colors.foreground },
  ghost: {
    color: {
      default: colors.mutedForeground,
      ":hover": colors.foreground,
    },
  },
  surface: {
    position: "absolute",
    inset: space.px,
    borderRadius: "inherit",
    transitionProperty: "box-shadow, background-color",
    transitionDuration: {
      default: `${durations.press}, ${durations.fast}`,
      [stylex.when.ancestor(":active")]: `${durations.fast}, ${durations.fast}`,
    },
    transitionTimingFunction: `${durations.pressEase}, ease`,
  },
  primarySurface: {
    backgroundColor: {
      default: colors.foreground,
      [stylex.when.ancestor(":hover")]: primaryHover,
      [stylex.when.ancestor(":active")]: primaryPress,
    },
    boxShadow: {
      default: `0 0 0 1px ${colors.foreground}`,
      [stylex.when.ancestor(":hover")]: `0 0 0 1px ${primaryHover}`,
      [stylex.when.ancestor(":active")]: `0 0 0 0px ${primaryPress}`,
    },
  },
  secondarySurface: {
    backgroundColor: {
      default: colors.accent,
      [stylex.when.ancestor(":hover")]: secondaryHover,
      [stylex.when.ancestor(":active")]: colors.accent,
    },
    boxShadow: {
      default: `0 0 0 1px ${colors.accent}`,
      [stylex.when.ancestor(":hover")]: `0 0 0 1px ${secondaryHover}`,
      [stylex.when.ancestor(":active")]: `0 0 0 0px ${colors.accent}`,
    },
  },
  // The border is an outer ring at rest that hands off to an inset ring when
  // pressed, so it moves inward with the surface.
  tertiarySurface: {
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":hover")]: colors.hover,
      [stylex.when.ancestor(":active")]: colors.active,
    },
    boxShadow: {
      default: `0 0 0 1px ${colors.border}, inset 0 0 0 0px ${colors.border}`,
      [stylex.when.ancestor(":active")]:
        `0 0 0 0px ${colors.border}, inset 0 0 0 1px ${colors.border}`,
    },
  },
  ghostSurface: {
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":hover")]: colors.hover,
      [stylex.when.ancestor(":active")]: colors.active,
    },
    boxShadow: {
      default: "0 0 0 1px transparent",
      [stylex.when.ancestor(":hover")]: `0 0 0 1px ${colors.hover}`,
      [stylex.when.ancestor(":active")]: `0 0 0 0px ${colors.active}`,
    },
  },
  content: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "inherit",
  },
  hidden: { opacity: 0 },
  spinnerBox: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    height: "100%",
    aspectRatio: "1",
  },
  spinnerPath: {
    strokeDasharray: "15 85",
    animationName: `${spinnerMove}, ${spinnerDash}`,
    animationDuration: "2s, 4s",
    animationTimingFunction: "linear, ease-in-out",
    animationIterationCount: "infinite",
  },
});

const surfaces = {
  primary: styles.primarySurface,
  secondary: styles.secondarySurface,
  tertiary: styles.tertiarySurface,
  ghost: styles.ghostSurface,
} as const;

/** The spinner: a figure eight traced by a dash that runs and breathes. */
function Spinner() {
  return (
    <span {...stylex.props(styles.spinnerBox)}>
      <svg {...stylex.props(styles.spinner)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          {...stylex.props(styles.spinnerPath)}
          d="M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z"
          stroke="currentColor"
          strokeWidth="1.125"
          strokeLinecap="round"
          pathLength="100"
        />
      </svg>
    </span>
  );
}

export function Button({
  variant = "primary",
  size = "default",
  loading = false,
  disabled = false,
  xstyle,
  children,
  ...props
}: ButtonProps) {
  const inert = disabled || loading;

  return (
    <BaseButton
      {...props}
      disabled={inert}
      aria-busy={loading || undefined}
      {...stylex.props(
        stylex.defaultMarker(),
        styles.root,
        styles[size],
        styles[variant],
        inert && styles.disabled,
        xstyle,
      )}
    >
      <span aria-hidden="true" {...stylex.props(styles.surface, surfaces[variant])} />
      <span {...stylex.props(styles.content)}>
        {loading ? (
          <>
            <span {...stylex.props(styles.content, styles.hidden)}>{children}</span>
            <Spinner />
          </>
        ) : (
          children
        )}
      </span>
    </BaseButton>
  );
}
