/**
 * Menu, ported from Fluid Functionalism's Base UI dropdown (MIT, see NOTICE).
 * The popup grows from the side it opens on with the fast spring, and one
 * highlight glides between rows, following the pointer and keyboard focus.
 */
import { Menu as BaseMenu } from "@base-ui/react/menu";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { createContext, use, useMemo, type ReactNode } from "react";
import { FluidHighlight, useFluidHover } from "./fluid-hover.tsx";
import { forMotion } from "./motion-props.ts";
import { spring } from "./springs.ts";
import { colors, durations, fonts, radii, shadows, space, text, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  positioner: {
    zIndex: 50,
    outline: "none",
  },
  popup: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    width: "18rem",
    maxWidth: "var(--available-width)",
    minWidth: "var(--anchor-width)",
    maxHeight: "min(480px, var(--available-height))",
    overflowY: "auto",
    borderRadius: radii.container,
    backgroundColor: colors.surface3,
    boxShadow: shadows.surface3,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    userSelect: "none",
    outline: "none",
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
    height: space.control,
    paddingInline: space.s2,
    borderRadius: radii.item,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
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
  highlighted: { color: colors.foreground },
  destructive: { color: colors.destructive },
  disabled: {
    opacity: 0.5,
    pointerEvents: "none",
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
}

export function MenuContent({ children }: MenuContentProps) {
  const { containerRef, register, light, active, handlers } = useFluidHover<
    HTMLDivElement,
    ItemKey
  >("y");

  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        side="bottom"
        align="start"
        sideOffset={6}
        {...stylex.props(styles.positioner)}
      >
        <BaseMenu.Popup
          render={(props, state) => {
            const exiting = state.transitionStatus === "ending";
            const hidden = { opacity: 0, y: enterOffset[state.side], scaleY: 0.96 };

            return (
              <motion.div
                {...forMotion(props)}
                className={stylex.props(styles.popup).className}
                initial={hidden}
                animate={exiting ? hidden : { opacity: 1, y: 0, scaleY: 1 }}
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
