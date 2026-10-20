/**
 * Tooltip: a small card of detail that shows while the pointer rests on, or
 * keyboard focus is on, the element it explains. It fades in, without moving
 * when the user asks for less motion. A tooltip is seen, not read out, so what
 * it explains names itself in full (`aria-label`) for assistive tech.
 */
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { motion, useReducedMotionConfig } from "motion/react";
import type { ReactElement, ReactNode } from "react";
import { forMotion } from "./motion-props.ts";
import { spring } from "./springs.ts";
import { colors, fonts, radii, shadows, space, text } from "./tokens.stylex.ts";

const styles = stylex.create({
  positioner: { zIndex: 50 },
  popup: {
    boxSizing: "border-box",
    maxWidth: "min(320px, var(--available-width))",
    paddingBlock: space.s2,
    paddingInline: space.s2_5,
    // Invisible, until forced colours draw it as the popup's edge.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radii.item,
    backgroundColor: colors.surface4,
    boxShadow: shadows.surface4,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    fontSize: text.caption,
    lineHeight: 1.5,
    color: colors.foreground,
    overflowWrap: "anywhere",
    pointerEvents: "none",
    transformOrigin: "var(--transform-origin)",
  },
});

export interface TooltipProps {
  /** What the tooltip shows. */
  readonly content: ReactNode;
  /** The element it explains, which takes the hover and focus handlers: one that can be focused. */
  readonly children: ReactElement;
}

export function Tooltip({ content, children }: TooltipProps) {
  const still = useReducedMotionConfig() ?? false;

  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={200} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} {...stylex.props(styles.positioner)}>
          <BaseTooltip.Popup
            render={(props, state) => {
              const exiting = state.transitionStatus === "ending";
              const hidden = still ? { opacity: 0 } : { opacity: 0, scale: 0.97 };
              const shown = still ? { opacity: 1 } : { opacity: 1, scale: 1 };

              return (
                <motion.div
                  {...forMotion(props)}
                  className={stylex.props(styles.popup).className}
                  initial={hidden}
                  animate={exiting ? hidden : shown}
                  transition={exiting ? spring.fast.exit : spring.fast}
                />
              );
            }}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
