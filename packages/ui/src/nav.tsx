/**
 * NavList and NavItem: an app's page navigation, as the rows of Fluid
 * Functionalism's sidebar menu (MIT, see NOTICE). The current page's fill
 * springs between rows, and a hover highlight glides under the pointer. A
 * lit row's label and icon turn to the foreground, and the current one's
 * label turns semibold without reflowing. Each item renders the app's own
 * link (its router's `Link`), marked `aria-current="page"` when it is the
 * current page.
 */
import { useRender } from "@base-ui/react/use-render";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { createContext, use, useId, type ReactNode } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { spring } from "./springs.ts";
import { colors, durations, radii, space, text, fontWeights, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  nav: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
  },
  highlight: { borderRadius: radii.item },
  item: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2,
    height: "32px",
    paddingInline: space.s2,
    borderRadius: radii.item,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    color: colors.mutedForeground,
    textDecoration: "none",
    whiteSpace: "nowrap",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  lit: { color: colors.foreground },
  indicator: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    borderRadius: radii.item,
    backgroundColor: colors.active,
    // Forced colours drop the fill, so an outline marks the choice instead.
    borderStyle: "solid",
    borderWidth: { default: 0, "@media (forced-colors: active)": 1 },
    borderColor: "Highlight",
  },
  icon: {
    display: "flex",
    flexShrink: 0,
  },
  // The label and, hidden in the same grid cell, a semibold copy that holds
  // its width, so turning semibold doesn't move what follows.
  label: {
    display: "inline-grid",
    minWidth: 0,
  },
  labelCell: {
    gridArea: "1 / 1",
    overflow: "hidden",
    textOverflow: "ellipsis",
    transitionProperty: "font-variation-settings",
    transitionDuration: durations.fast,
  },
  ghost: {
    visibility: "hidden",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  semibold: { fontVariationSettings: weights.semibold, fontWeight: fontWeights.semibold },
});

interface NavState {
  readonly register: (key: string) => (element: HTMLElement | null) => void;
  readonly light: (key: string | null) => void;
  readonly hovered: string | null;
  readonly indicator: string;
}

const NavContext = createContext<NavState>({
  register: () => () => {},
  light: () => {},
  hovered: null,
  indicator: "",
});

export interface NavListProps {
  /** Names the navigation landmark. */
  readonly label: string;
  readonly children?: ReactNode;
}

export function NavList({ label, children }: NavListProps) {
  const { containerRef, register, light, active, handlers } = useFluidHover<HTMLElement, string>(
    "y",
  );

  const indicator = useId();

  return (
    <NavContext value={{ register, light, hovered: active?.key ?? null, indicator }}>
      <nav ref={containerRef} aria-label={label} {...handlers} {...stylex.props(styles.nav)}>
        <FluidHighlight rect={active?.rect ?? null} xstyle={styles.highlight} />
        {children}
      </nav>
    </NavContext>
  );
}

export interface NavItemProps {
  readonly label: string;
  readonly icon?: ReactNode;
  /** Whether this item is the current page. */
  readonly current: boolean;
  /**
   * Renders the link, given the item's props and content to spread onto it:
   * `(props) => <Link to="/keys" {...props} />`.
   */
  readonly render: useRender.RenderProp;
}

export function NavItem({ label, icon, current, render }: NavItemProps) {
  const { register, light, hovered, indicator } = use(NavContext);

  return useRender({
    render,
    ref: register(label),
    props: {
      "aria-current": current ? "page" : undefined,
      onFocus: (event: { currentTarget: Element }) => {
        if (event.currentTarget.matches(":focus-visible")) light(label);
      },
      onBlur: () => light(null),
      ...stylex.props(styles.item, (current || hovered === label) && styles.lit),
      children: (
        <>
          {current && (
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
            <span aria-hidden="true" {...stylex.props(styles.labelCell, styles.ghost)}>
              {label}
            </span>
            <span {...stylex.props(styles.labelCell, current && styles.semibold)}>{label}</span>
          </span>
        </>
      ),
    },
  });
}
