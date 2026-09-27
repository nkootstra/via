/**
 * Toast: brief notices in the corner, in Fluid Functionalism's surface and
 * motion language (it has no toast of its own; MIT, see NOTICE). Base UI
 * announces each one through a polite live region, pauses the timers while
 * the pointer or focus is on the stack, and lets F6 reach it.
 */
import { Toast as BaseToast } from "@base-ui/react/toast";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "./button.tsx";
import { XIcon } from "./icons.tsx";
import { forMotion } from "./motion-props.ts";
import { spring } from "./springs.ts";
import { colors, fonts, radii, shadows, space, text, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  viewport: {
    position: "fixed",
    right: space.s4,
    bottom: space.s4,
    zIndex: 60,
    display: "flex",
    flexDirection: "column-reverse",
    gap: space.s2,
    width: "min(360px, calc(100vw - 2rem))",
    outline: "none",
  },
  toast: {
    position: "relative",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingBlock: space.s3,
    paddingLeft: space.s4,
    paddingRight: "44px",
    borderRadius: radii.container,
    backgroundColor: colors.surface5,
    boxShadow: shadows.surface5,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    outline: {
      default: "none",
      ":focus-visible": `1px solid ${colors.focusRing}`,
    },
  },
  title: {
    margin: 0,
    fontSize: text.body,
    fontVariationSettings: weights.semibold,
    color: colors.foreground,
  },
  errorTitle: { color: colors.destructive },
  description: {
    margin: 0,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  close: {
    position: "absolute",
    top: space.s2,
    right: space.s2,
  },
});

/**
 * Adds and closes toasts: `useToast().add({ title, description })`. A toast
 * of `type: "error"` shows its title in the destructive colour.
 */
export const useToast = BaseToast.useToastManager;

/** Holds the toasts and renders their stack; wrap the app in it once. */
export function ToastProvider({ children }: { readonly children?: ReactNode }) {
  return (
    <BaseToast.Provider>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport {...stylex.props(styles.viewport)}>
          <Toasts />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

function Toasts() {
  const { toasts } = useToast();

  return toasts.map((toast) => (
    <BaseToast.Root
      key={toast.id}
      toast={toast}
      render={(props, state) => {
        const exiting = state.transitionStatus === "ending";

        return (
          <motion.div
            {...forMotion(props)}
            className={stylex.props(styles.toast).className}
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={exiting ? { opacity: 0, y: 0, scale: 0.97 } : { opacity: 1, y: 0, scale: 1 }}
            transition={exiting ? spring.slow.exit : spring.slow}
          />
        );
      }}
    >
      <BaseToast.Title
        {...stylex.props(styles.title, toast.type === "error" && styles.errorTitle)}
      />
      <BaseToast.Description {...stylex.props(styles.description)} />
      <BaseToast.Close
        render={
          <Button variant="ghost" size="icon-compact" aria-label="Close" xstyle={styles.close}>
            <XIcon size={14} />
          </Button>
        }
      />
    </BaseToast.Root>
  ));
}
