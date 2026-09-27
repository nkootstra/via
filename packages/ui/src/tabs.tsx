/**
 * Tabs, ported from Fluid Functionalism's Base UI tabs (MIT, see NOTICE): a
 * segmented control. The selected segment's raised surface springs between
 * tabs, a hover highlight glides under the pointer, and the selected label
 * turns semibold without changing width, because an invisible semibold copy
 * reserves it.
 */
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { createContext, use, useId, type ComponentProps, type ReactNode } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { spring } from "./springs.ts";
import { colors, durations, radii, shadows, space, text, weights } from "./tokens.stylex.ts";

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
  tab: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    height: "28px",
    paddingInline: space.s3,
    borderWidth: 0,
    borderRadius: radii.item,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.body,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `1px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
  },
  indicator: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    borderRadius: radii.item,
    backgroundColor: colors.surface4,
    boxShadow: shadows.surface4,
  },
  // Both copies sit in one grid cell: the invisible semibold one sizes it.
  label: {
    display: "inline-grid",
    whiteSpace: "nowrap",
  },
  ghost: {
    gridArea: "1 / 1",
    visibility: "hidden",
    fontVariationSettings: weights.semibold,
  },
  text: {
    gridArea: "1 / 1",
    color: colors.mutedForeground,
    fontVariationSettings: weights.normal,
    transitionProperty: "color, font-variation-settings",
    transitionDuration: durations.fast,
  },
  lit: { color: colors.foreground },
  selected: {
    color: colors.foreground,
    fontVariationSettings: weights.semibold,
  },
  panel: { outline: "none" },
});

interface TabsListState {
  readonly register: (value: string) => (element: HTMLElement | null) => void;
  readonly light: (value: string | null) => void;
  readonly hovered: string | null;
  /** Shared by the list's selection indicators, so motion glides one between tabs. */
  readonly indicator: string;
}

const TabsListContext = createContext<TabsListState>({
  register: () => () => {},
  light: () => {},
  hovered: null,
  indicator: "",
});

export interface TabsProps {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly children?: ReactNode;
}

export function Tabs({ value, defaultValue, onValueChange, children }: TabsProps) {
  return (
    <BaseTabs.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next: string) => onValueChange?.(next)}
    >
      {children}
    </BaseTabs.Root>
  );
}

export type TabsListProps = Omit<ComponentProps<typeof BaseTabs.List>, "className" | "style">;

export function TabsList({ children, ...props }: TabsListProps) {
  const { containerRef, register, light, active, handlers } = useFluidHover<HTMLDivElement, string>(
    "x",
  );

  const indicator = useId();
  const state = { register, light, hovered: active?.key ?? null, indicator };

  return (
    <TabsListContext value={state}>
      <BaseTabs.List
        {...props}
        ref={containerRef}
        // Arrow keys move the selection along with focus.
        activateOnFocus
        onPointerMove={handlers.onPointerMove}
        onPointerLeave={handlers.onPointerLeave}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) light(null);
        }}
        {...stylex.props(styles.list)}
      >
        <FluidHighlight rect={active?.rect ?? null} xstyle={styles.highlight} />
        {children}
      </BaseTabs.List>
    </TabsListContext>
  );
}

export interface TabItemProps {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export function TabItem({ value, label, disabled = false }: TabItemProps) {
  const { register, light, hovered, indicator } = use(TabsListContext);

  return (
    <BaseTabs.Tab
      value={value}
      disabled={disabled}
      ref={register(value)}
      // Keyboard focus lights the tab the way the pointer does.
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible")) light(value);
      }}
      render={(props, state) => (
        <button {...props} {...stylex.props(styles.tab)}>
          {state.active && (
            <motion.span
              layoutId={indicator}
              transition={spring.moderate}
              {...stylex.props(styles.indicator)}
            />
          )}
          <span {...stylex.props(styles.label)}>
            <span aria-hidden="true" {...stylex.props(styles.ghost)}>
              {label}
            </span>
            <span
              {...stylex.props(
                styles.text,
                hovered === value && styles.lit,
                state.active && styles.selected,
              )}
            >
              {label}
            </span>
          </span>
        </button>
      )}
    />
  );
}

export type TabPanelProps = Omit<ComponentProps<typeof BaseTabs.Panel>, "className" | "style">;

export function TabPanel(props: TabPanelProps) {
  return <BaseTabs.Panel {...props} {...stylex.props(styles.panel)} />;
}
