/**
 * Sheet: a dialog that slides in from the page's right edge, for reading
 * something at length beside the page that opened it, such as a request. It
 * floats a gutter in from the edges on a wide screen and fills a phone's. Its
 * header, with the title, a line about it, its actions and the ✕, stays put
 * while the body scrolls. Focus is trapped in it, Escape closes it, and focus
 * goes back to its trigger.
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { motion, useReducedMotionConfig } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "./button.tsx";
import { XIcon } from "./icons.tsx";
import { forMotion } from "./motion-props.ts";
import { spring } from "./springs.ts";
import {
  colors,
  fonts,
  fontWeights,
  radii,
  shadows,
  space,
  text,
  tracking,
  weights,
} from "./tokens.stylex.ts";

const PHONE = "@media (max-width: 640px)";

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    backgroundColor: colors.backdrop,
  },
  popup: {
    position: "fixed",
    top: { default: space.s2, [PHONE]: 0 },
    bottom: { default: space.s2, [PHONE]: 0 },
    right: { default: space.s2, [PHONE]: 0 },
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: { default: "min(44rem, calc(100% - 3rem))", [PHONE]: "100%" },
    overflow: "hidden",
    // Invisible, until forced colours draw it as the panel's edge.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: { default: radii.container, [PHONE]: 0 },
    backgroundColor: colors.surface5,
    boxShadow: shadows.surface5,
    color: colors.foreground,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    fontSize: text.body,
    outline: "none",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    flexShrink: 0,
    paddingBlock: space.s4,
    paddingInlineStart: space.s6,
    paddingInlineEnd: space.s4,
    borderBottom: `1px solid ${colors.border}`,
  },
  heading: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space.s1,
    minWidth: 0,
    // Centred on the 28px buttons beside it.
    paddingTop: "3px",
  },
  title: {
    margin: 0,
    fontSize: text.title,
    lineHeight: 1.35,
    letterSpacing: tracking.snug,
    overflowWrap: "anywhere",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  description: {
    margin: 0,
    fontSize: text.caption,
    lineHeight: 1.5,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    flexShrink: 0,
  },
  body: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingTop: space.s4,
    paddingBottom: space.s6,
    paddingInline: { default: space.s6, [PHONE]: space.s4 },
  },
});

interface TransitionState {
  readonly transitionStatus: "starting" | "ending" | "idle" | undefined;
}

export const Sheet = BaseDialog.Root;

export interface SheetContentProps {
  /** Names the sheet. */
  readonly title: ReactNode;
  /** A line under the title, which describes the sheet. */
  readonly description?: ReactNode;
  /** Buttons beside the ✕, such as copying what it shows. */
  readonly actions?: ReactNode;
  /** Where focus goes once it closes, when not back to its trigger. */
  readonly finalFocus?: ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
  readonly children?: ReactNode;
}

/** The backdrop and the panel, portalled to the body. */
export function SheetContent({
  title,
  description,
  actions,
  finalFocus,
  children,
}: SheetContentProps) {
  const still = useReducedMotionConfig() ?? false;

  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        render={(props, state: TransitionState) => {
          const exiting = state.transitionStatus === "ending";

          return (
            <motion.div
              {...forMotion(props)}
              className={stylex.props(styles.backdrop).className}
              initial={{ opacity: 0 }}
              animate={{ opacity: exiting ? 0 : 1 }}
              transition={exiting ? spring.slow.exit : spring.slow}
            />
          );
        }}
      />
      <BaseDialog.Popup
        finalFocus={finalFocus}
        render={(props, state: TransitionState) => {
          const exiting = state.transitionStatus === "ending";
          // In from the right, by a little: far enough to say where it came from.
          const away = still ? { opacity: 0 } : { opacity: 0, x: 24 };
          const here = still ? { opacity: 1 } : { opacity: 1, x: 0 };

          return (
            <motion.div
              {...forMotion(props)}
              className={stylex.props(styles.popup).className}
              initial={away}
              animate={exiting ? away : here}
              transition={exiting ? spring.slow.exit : spring.slow}
            />
          );
        }}
      >
        <div {...stylex.props(styles.header)}>
          <div {...stylex.props(styles.heading)}>
            <BaseDialog.Title {...stylex.props(styles.title)}>{title}</BaseDialog.Title>
            {description !== undefined && (
              <BaseDialog.Description {...stylex.props(styles.description)}>
                {description}
              </BaseDialog.Description>
            )}
          </div>
          <div {...stylex.props(styles.actions)}>
            {actions}
            <BaseDialog.Close
              render={
                <Button variant="ghost" size="icon-compact" aria-label="Close">
                  <XIcon size={14} />
                </Button>
              }
            />
          </div>
        </div>
        <div {...stylex.props(styles.body)}>{children}</div>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}
