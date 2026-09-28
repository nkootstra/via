/**
 * Dialog, ported from Fluid Functionalism's Base UI dialog (MIT, see NOTICE).
 * The panel and backdrop enter on the slow spring and leave on its quicker
 * exit tween; Base UI keeps them mounted until motion's animations finish.
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Button } from "./button.tsx";
import { XIcon } from "./icons.tsx";
import { forMotion } from "./motion-props.ts";
import { spring } from "./springs.ts";
import {
  colors,
  fonts,
  radii,
  shadows,
  space,
  text,
  tracking,
  fontWeights,
  weights,
} from "./tokens.stylex.ts";

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    backgroundColor: colors.backdrop,
  },
  popup: {
    position: "fixed",
    top: "50%",
    left: "50%",
    zIndex: 50,
    boxSizing: "border-box",
    width: "calc(100% - 2rem)",
    // A short viewport scrolls the panel rather than pushing its title, ✕ or
    // footer off screen.
    maxHeight: "calc(100dvh - 2rem)",
    overflowY: "auto",
    padding: space.s6,
    // Invisible, until forced colours draw it as the panel's edge.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radii.container,
    backgroundColor: colors.surface5,
    boxShadow: shadows.surface5,
    color: colors.foreground,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    outline: "none",
  },
  sm: { maxWidth: "400px" },
  lg: { maxWidth: "540px" },
  // Centred on the title's line: 24px of padding plus half its 20px line,
  // less half the 28px button.
  close: {
    position: "absolute",
    insetBlockStart: "20px",
    insetInlineEnd: "20px",
  },
  title: {
    margin: 0,
    fontSize: text.title,
    lineHeight: 1.25,
    letterSpacing: tracking.snug,
    // Clear of the ✕, and broken anywhere rather than overflowing.
    paddingInlineEnd: space.s6,
    overflowWrap: "anywhere",
    fontVariationSettings: weights.bold,
    fontWeight: fontWeights.bold,
    color: colors.foreground,
  },
  description: {
    margin: 0,
    fontSize: text.body,
    color: colors.mutedForeground,
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    marginBottom: space.s4,
  },
  footer: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: space.s2,
    marginTop: space.s6,
  },
});

interface TransitionState {
  readonly transitionStatus: "starting" | "ending" | "idle" | undefined;
}

export const Dialog = BaseDialog.Root;

export const DialogTrigger = BaseDialog.Trigger;

export const DialogClose = BaseDialog.Close;

export interface DialogContentProps {
  /** Width: sm 400px, lg 540px. */
  readonly size?: "sm" | "lg";
  /**
   * Where focus goes once it closes, when not back to its trigger: such as
   * when the trigger went with what the dialog removed.
   */
  readonly finalFocus?: ComponentProps<typeof BaseDialog.Popup>["finalFocus"];
  readonly children?: ReactNode;
}

/** The backdrop and panel, portalled to the body. */
export function DialogContent({ size = "sm", finalFocus, children }: DialogContentProps) {
  return (
    <DialogPanel size={size} finalFocus={finalFocus} closeButton>
      {children}
    </DialogPanel>
  );
}

/** The panel shared by Dialog and AlertDialog; only a Dialog gets the ✕. */
export function DialogPanel({
  size,
  finalFocus,
  closeButton,
  children,
}: Required<Pick<DialogContentProps, "size">> &
  Pick<DialogContentProps, "finalFocus"> & {
    readonly closeButton: boolean;
    readonly children?: ReactNode;
  }) {
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

          return (
            <motion.div
              {...forMotion(props)}
              className={stylex.props(styles.popup, styles[size]).className}
              initial={{ opacity: 0, scale: 0.97, x: "-50%", y: "-50%" }}
              animate={{
                opacity: exiting ? 0 : 1,
                scale: exiting ? 0.97 : 1,
                x: "-50%",
                y: "-50%",
              }}
              transition={exiting ? spring.slow.exit : spring.slow}
            />
          );
        }}
      >
        {children}
        {closeButton && (
          <BaseDialog.Close
            render={
              <Button variant="ghost" size="icon-compact" aria-label="Close" xstyle={styles.close}>
                <XIcon size={14} />
              </Button>
            }
          />
        )}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

type SectionProps = Omit<HTMLAttributes<HTMLDivElement>, "className" | "style">;

export function DialogHeader(props: SectionProps) {
  return <div {...props} {...stylex.props(styles.header)} />;
}

export function DialogFooter(props: SectionProps) {
  return <div {...props} {...stylex.props(styles.footer)} />;
}

export function DialogTitle(
  props: Omit<ComponentProps<typeof BaseDialog.Title>, "className" | "style">,
) {
  return <BaseDialog.Title {...props} {...stylex.props(styles.title)} />;
}

export function DialogDescription(
  props: Omit<ComponentProps<typeof BaseDialog.Description>, "className" | "style">,
) {
  return <BaseDialog.Description {...props} {...stylex.props(styles.description)} />;
}
