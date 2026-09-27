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
import { colors, fonts, radii, shadows, space, text, weights } from "./tokens.stylex.ts";

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
    padding: space.s6,
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
  close: {
    position: "absolute",
    top: space.s3,
    right: space.s3,
  },
  title: {
    margin: 0,
    fontSize: text.title,
    lineHeight: 1.25,
    fontVariationSettings: weights.bold,
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
  readonly children?: ReactNode;
}

/** The backdrop and panel, portalled to the body. */
export function DialogContent({ size = "sm", children }: DialogContentProps) {
  return (
    <DialogPanel size={size} closeButton>
      {children}
    </DialogPanel>
  );
}

/** The panel shared by Dialog and AlertDialog; only a Dialog gets the ✕. */
export function DialogPanel({
  size,
  closeButton,
  children,
}: Required<Pick<DialogContentProps, "size">> & {
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
