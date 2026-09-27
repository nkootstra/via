/**
 * NavList and NavItem: an app's page navigation, in the Tabs' motion
 * language from Fluid Functionalism (MIT, see NOTICE). The current page's
 * raised surface springs between items, and a hover highlight glides under
 * the pointer. Each item renders the app's own link (its router's `Link`),
 * marked `aria-current="page"` when it is the current page.
 */
import { useRender } from "@base-ui/react/use-render";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { createContext, use, useId, type ReactNode } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { spring } from "./springs.ts";
import { colors, durations, radii, shadows, space, text, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  nav: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
  },
  horizontal: {
    flexDirection: "row",
    overflowX: "auto",
    scrollbarWidth: "none",
  },
  highlight: { borderRadius: radii.item },
  item: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s2_5,
    height: "32px",
    paddingInline: space.s2_5,
    borderRadius: radii.item,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    color: colors.mutedForeground,
    textDecoration: "none",
    whiteSpace: "nowrap",
    outline: {
      default: "none",
      ":focus-visible": `1px solid ${colors.focusRing}`,
    },
    outlineOffset: "1px",
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  lit: { color: colors.foreground },
  current: {
    color: colors.foreground,
    fontVariationSettings: weights.medium,
  },
  indicator: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    borderRadius: radii.item,
    backgroundColor: colors.surface4,
    boxShadow: shadows.surface4,
  },
  icon: {
    display: "flex",
    flexShrink: 0,
    opacity: 0.8,
  },
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
  readonly orientation?: "vertical" | "horizontal";
  readonly children?: ReactNode;
}

export function NavList({ label, orientation = "vertical", children }: NavListProps) {
  const horizontal = orientation === "horizontal";

  const { containerRef, register, light, active, handlers } = useFluidHover<HTMLElement, string>(
    horizontal ? "x" : "y",
  );

  const indicator = useId();

  return (
    <NavContext value={{ register, light, hovered: active?.key ?? null, indicator }}>
      <nav
        ref={containerRef}
        aria-label={label}
        {...handlers}
        {...stylex.props(styles.nav, horizontal && styles.horizontal)}
      >
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
      ...stylex.props(styles.item, hovered === label && styles.lit, current && styles.current),
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
          {label}
        </>
      ),
    },
  });
}
