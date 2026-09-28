/**
 * Menu, ported from Fluid Functionalism's Base UI dropdown (MIT, see NOTICE).
 * The popup grows from its trigger with the fast spring, or only fades when
 * the user asks for less motion, and one highlight glides between rows,
 * following the pointer and keyboard focus. A radio group offers a choice of
 * one: the chosen row sits on the active fill, semibold, with a check.
 */
import { Menu as BaseMenu } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import { motion, useReducedMotion } from "motion/react";
import { createContext, use, useMemo, type ReactNode } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { forMotion } from "./motion-props.ts";
import { spring } from "./springs.ts";
import {
  colors,
  durations,
  fonts,
  radii,
  shadows,
  space,
  text,
  fontWeights,
  weights,
} from "./tokens.stylex.ts";

const styles = stylex.create({
  positioner: {
    zIndex: 50,
    outline: "none",
  },
  popup: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    // As wide as its longest item, so a short menu of row actions stays small.
    minWidth: "max(10rem, var(--anchor-width))",
    maxWidth: "var(--available-width)",
    maxHeight: "min(480px, var(--available-height))",
    overflowY: "auto",
    // Invisible, until forced colours draw it as the popup's edge.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radii.container,
    backgroundColor: colors.surface3,
    boxShadow: shadows.surface3,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    userSelect: "none",
    outline: "none",
    // Base UI's origin: the point of the trigger the popup grows from.
    transformOrigin: "var(--transform-origin)",
  },
  list: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    padding: space.s1,
  },
  highlight: { borderRadius: radii.item },
  item: {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    minHeight: space.control,
    paddingBlock: space.s2,
    paddingInline: space.s2,
    boxSizing: "border-box",
    overflowWrap: "anywhere",
    borderRadius: radii.item,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    color: colors.mutedForeground,
    cursor: "pointer",
    outline: "none",
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  icon: {
    display: "flex",
    flexShrink: 0,
    marginInlineEnd: space.s2,
  },
  highlighted: {
    color: colors.foreground,
    // Forced colours drop the gliding highlight, so an outline follows the row.
    outline: { default: "none", "@media (forced-colors: active)": "2px solid Highlight" },
    outlineOffset: "-2px",
  },
  destructive: { color: colors.destructive },
  disabled: {
    opacity: 0.5,
    pointerEvents: "none",
  },
  // A menu anchored to a sidebar row: its items start on the row's edge and
  // their glyphs and labels on the sidebar's axes, 10px wider than the row.
  fitAnchor: {
    width: "calc(var(--anchor-width) + 10px)",
    minWidth: "240px",
  },
  groupLabel: {
    flexShrink: 0,
    paddingBlock: space.s1_5,
    paddingInline: space.s2,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  radioItem: { paddingInlineEnd: space.s1_5 },
  checked: {
    color: colors.foreground,
    backgroundColor: colors.active,
    // Forced colours drop the fill, so an outline marks the choice instead.
    outline: { default: "none", "@media (forced-colors: active)": "1px solid Highlight" },
    outlineOffset: "-1px",
  },
  // The label and, hidden in the same grid cell, a semibold copy that holds
  // its width, so turning semibold doesn't move the check.
  label: {
    display: "inline-grid",
    flexGrow: 1,
  },
  labelCell: { gridArea: "1 / 1" },
  ghost: {
    visibility: "hidden",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  semibold: {
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  check: {
    display: "flex",
    flexShrink: 0,
    marginInlineStart: space.s2,
    color: colors.foreground,
  },
  separator: {
    flexShrink: 0,
    height: "1px",
    marginBlock: space.s1,
    marginInline: `calc(-1 * ${space.s1})`,
    backgroundColor: `color-mix(in srgb, ${colors.border} 60%, transparent)`,
  },
});

// The popup slides 4px in from its anchor, whichever side it lands on.
const enterOffset = {
  top: 4,
  bottom: -4,
  left: 0,
  right: 0,
  "inline-start": 0,
  "inline-end": 0,
} as const;

/** An item's key in the highlight: its identity, and whether it destroys something. */
interface ItemKey {
  readonly destructive: boolean;
}

interface MenuListState {
  readonly register: (key: ItemKey) => (element: HTMLElement | null) => void;
  readonly light: (key: ItemKey | null) => void;
}

const MenuListContext = createContext<MenuListState>({
  register: () => () => {},
  light: () => {},
});

export const Menu = BaseMenu.Root;

export const MenuTrigger = BaseMenu.Trigger;

export interface MenuContentProps {
  readonly children?: ReactNode;
  /** Which edge of the trigger the popup lines up with: `end` for a trigger at a row's right. */
  readonly align?: "start" | "end";
  /** Which side of the trigger it opens on: `top` for a trigger at the bottom of the screen. */
  readonly side?: "top" | "bottom";
  /** Sized and placed on a sidebar row's grid: 10px wider than the row, 4px out to its left. */
  readonly fitAnchor?: boolean;
}

export function MenuContent({
  children,
  align = "start",
  side = "bottom",
  fitAnchor = false,
}: MenuContentProps) {
  const { containerRef, register, light, active, handlers } = useFluidHover<
    HTMLDivElement,
    ItemKey
  >("y");

  const still = useReducedMotion() ?? false;

  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        side={side}
        align={align}
        sideOffset={6}
        alignOffset={fitAnchor ? -4 : 0}
        {...stylex.props(styles.positioner)}
      >
        <BaseMenu.Popup
          render={(props, state) => {
            const exiting = state.transitionStatus === "ending";

            const hidden = still
              ? { opacity: 0 }
              : { opacity: 0, y: enterOffset[state.side], scaleY: 0.96 };

            const shown = still ? { opacity: 1 } : { opacity: 1, y: 0, scaleY: 1 };

            return (
              <motion.div
                {...forMotion(props)}
                className={stylex.props(styles.popup, fitAnchor && styles.fitAnchor).className}
                initial={hidden}
                animate={exiting ? hidden : shown}
                transition={exiting ? spring.fast.exit : spring.fast}
              />
            );
          }}
        >
          <MenuListContext value={{ register, light }}>
            <div
              ref={containerRef}
              onPointerMove={handlers.onPointerMove}
              onPointerLeave={handlers.onPointerLeave}
              {...stylex.props(styles.list)}
            >
              <FluidHighlight
                rect={active?.rect ?? null}
                destructive={active?.key.destructive ?? false}
                xstyle={styles.highlight}
              />
              {children}
            </div>
          </MenuListContext>
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}

export interface MenuItemProps {
  readonly label: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  /** Destroys something, such as removing an account: red, and so is its highlight. */
  readonly destructive?: boolean;
  /** A glyph before the label, in the label's colour. */
  readonly icon?: ReactNode;
}

export function MenuItem({
  label,
  onClick,
  disabled = false,
  destructive = false,
  icon,
}: MenuItemProps) {
  const { register, light } = use(MenuListContext);
  // The highlight finds the item by this object's identity, so it lives as long as the item.
  const key = useMemo(() => ({ destructive }), [destructive]);

  return (
    <BaseMenu.Item
      ref={register(key)}
      label={label}
      disabled={disabled}
      data-destructive={destructive ? "" : undefined}
      onClick={() => onClick?.()}
      // Base UI focuses the row it highlights, by pointer or keyboard.
      onFocus={() => light(key)}
      className={(state) =>
        stylex.props(
          styles.item,
          state.highlighted && styles.highlighted,
          destructive && styles.destructive,
          state.disabled && styles.disabled,
        ).className ?? ""
      }
    >
      {icon !== undefined && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          {icon}
        </span>
      )}
      {label}
    </BaseMenu.Item>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator {...stylex.props(styles.separator)} />;
}

export interface MenuRadioGroupProps {
  /** Names the group, shown above its items. */
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly children?: ReactNode;
}

/** A choice of one among its MenuRadioItems. */
export function MenuRadioGroup({ label, value, onValueChange, children }: MenuRadioGroupProps) {
  return (
    <BaseMenu.RadioGroup
      value={value}
      // The group's values are its items' `value` strings.
      onValueChange={(next: string) => onValueChange(next)}
    >
      <BaseMenu.GroupLabel {...stylex.props(styles.groupLabel)}>{label}</BaseMenu.GroupLabel>
      {children}
    </BaseMenu.RadioGroup>
  );
}

export interface MenuRadioItemProps {
  readonly value: string;
  readonly label: string;
  /** A glyph before the label, in the label's colour. */
  readonly icon?: ReactNode;
}

function CheckGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12L9 17L20 6" />
    </svg>
  );
}

/** One option of a MenuRadioGroup; picking it closes the menu. */
export function MenuRadioItem({ value, label, icon }: MenuRadioItemProps) {
  const { register, light } = use(MenuListContext);
  const key = useMemo(() => ({ destructive: false }), []);

  return (
    <BaseMenu.RadioItem
      ref={register(key)}
      value={value}
      label={label}
      closeOnClick
      onFocus={() => light(key)}
      className={(state) =>
        stylex.props(
          styles.item,
          styles.radioItem,
          state.highlighted && styles.highlighted,
          state.checked && styles.checked,
        ).className ?? ""
      }
      render={(props, state) => (
        <div {...props}>
          {icon !== undefined && (
            <span aria-hidden="true" {...stylex.props(styles.icon)}>
              {icon}
            </span>
          )}
          <span {...stylex.props(styles.label)}>
            <span aria-hidden="true" {...stylex.props(styles.labelCell, styles.ghost)}>
              {label}
            </span>
            <span {...stylex.props(styles.labelCell, state.checked && styles.semibold)}>
              {label}
            </span>
          </span>
          {state.checked && (
            <span {...stylex.props(styles.check)}>
              <CheckGlyph />
            </span>
          )}
        </div>
      )}
    />
  );
}
