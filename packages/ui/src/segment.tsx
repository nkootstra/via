/**
 * A segmented row's parts, ported from Fluid Functionalism's Base UI tabs
 * (MIT, see NOTICE), shared by Tabs and SegmentedControl. The selected
 * segment's raised surface springs between segments, a hover highlight glides
 * under the pointer, and the selected label turns semibold without changing
 * width, because an invisible semibold copy reserves it.
 */
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { createContext, use, useId, type FocusEvent, type ReactNode } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { spring } from "./springs.ts";
import {
  colors,
  durations,
  radii,
  shadows,
  space,
  text,
  fontWeights,
  weights,
} from "./tokens.stylex.ts";

const styles = stylex.create({
  list: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    padding: space.s1,
    borderRadius: radii.container,
    backgroundColor: colors.muted,
    userSelect: "none",
  },
  highlight: { borderRadius: radii.item },
  segment: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    height: "28px",
    paddingInline: space.s3,
    borderWidth: 0,
    borderRadius: radii.item,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.body,
    color: colors.mutedForeground,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  indicator: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    borderRadius: radii.item,
    backgroundColor: colors.surface4,
    boxShadow: shadows.surface4,
  },
  icon: { display: "flex" },
  // Both copies sit in one grid cell: the invisible semibold one sizes it.
  label: {
    display: "inline-grid",
    whiteSpace: "nowrap",
  },
  ghost: {
    gridArea: "1 / 1",
    visibility: "hidden",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  text: {
    gridArea: "1 / 1",
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    transitionProperty: "font-variation-settings",
    transitionDuration: durations.fast,
  },
  lit: { color: colors.foreground },
  selected: { color: colors.foreground },
  selectedText: {
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
});

interface SegmentsState {
  readonly register: (value: string) => (element: HTMLElement | null) => void;
  readonly light: (value: string | null) => void;
  readonly hovered: string | null;
  /** Shared by the row's selection indicators, so motion glides one between segments. */
  readonly indicator: string;
}

const SegmentsContext = createContext<SegmentsState>({
  register: () => () => {},
  light: () => {},
  hovered: null,
  indicator: "",
});

/**
 * A segmented row's state: `Provider` shares it with the segments, `rootProps`
 * go on the row's element, and `highlight` inside it.
 */
export function useSegments() {
  const { containerRef, register, light, active, handlers } = useFluidHover<HTMLDivElement, string>(
    "x",
  );

  const indicator = useId();

  return {
    state: { register, light, hovered: active?.key ?? null, indicator },
    rootProps: {
      ref: containerRef,
      onPointerMove: handlers.onPointerMove,
      onPointerLeave: handlers.onPointerLeave,
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) light(null);
      },
      ...stylex.props(styles.list),
    },
    highlight: <FluidHighlight rect={active?.rect ?? null} xstyle={styles.highlight} />,
  };
}

export const SegmentsProvider = SegmentsContext;

/**
 * A segment's part in the row, for the Base UI part that renders it: its place
 * in the highlight, and `look`, its element's style, selected or not.
 */
export function useSegment(value: string) {
  const { register, light, hovered } = use(SegmentsContext);

  return {
    ref: register(value),
    // Keyboard focus lights the segment the way the pointer does.
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible")) light(value);
    },
    look: (selected: boolean) =>
      stylex.props(styles.segment, hovered === value && styles.lit, selected && styles.selected),
  };
}

/** A segment's contents: the selection's surface when selected, its icon, and its label. */
export function SegmentFace({
  label,
  icon,
  selected,
}: {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly selected: boolean;
}) {
  const { indicator } = use(SegmentsContext);

  return (
    <>
      {selected && (
        <motion.span
          layoutId={indicator}
          transition={spring.moderate}
          {...stylex.props(styles.indicator)}
        />
      )}
      {icon !== undefined && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          {icon}
        </span>
      )}
      <span {...stylex.props(styles.label)}>
        <span aria-hidden="true" {...stylex.props(styles.ghost)}>
          {label}
        </span>
        <span {...stylex.props(styles.text, selected && styles.selectedText)}>{label}</span>
      </span>
    </>
  );
}
