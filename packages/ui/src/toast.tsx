/**
 * Toast: brief notices in the corner, in Fluid Functionalism's surface and
 * motion language (it has no toast of its own; MIT, see NOTICE). Base UI
 * announces each one through a polite live region, pauses the timers while
 * the pointer or focus is on the stack, and lets F6 reach it.
 */
import { Toast as BaseToast } from "@base-ui/react/toast";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { createContext, use, useMemo, type ReactNode } from "react";
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
  fontWeights,
  weights,
} from "./tokens.stylex.ts";

const styles = stylex.create({
  // The 16px gap from the screen's edge is padding, not an offset, so a pile
  // of toasts that scrolls rather than running off the top keeps its shadows
  // and focus rings inside the scroll area.
  viewport: {
    position: "fixed",
    insetInlineEnd: 0,
    // Clear of a phone's home indicator.
    insetBlockEnd: "env(safe-area-inset-bottom)",
    zIndex: 60,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column-reverse",
    gap: space.s2,
    width: `min(calc(360px + 2 * ${space.s4}), 100vw)`,
    maxHeight: "100dvh",
    padding: space.s4,
    overflowY: "auto",
    outline: "none",
    // Its padding, with or without toasts in it, lets clicks through to the page.
    pointerEvents: "none",
  },
  toast: {
    position: "relative",
    pointerEvents: "auto",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingBlock: space.s3,
    paddingInlineStart: space.s4,
    paddingInlineEnd: "44px",
    // Invisible, until forced colours draw it as the toast's edge.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radii.container,
    backgroundColor: colors.surface5,
    boxShadow: shadows.surface5,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
  },
  title: {
    margin: 0,
    overflowWrap: "anywhere",
    fontSize: text.body,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  errorTitle: { color: colors.destructive },
  description: {
    margin: 0,
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  action: { alignSelf: "flex-start", marginTop: space.s2 },
  // Concentric with the corner: the toast's 12px radius, less the button's 8px.
  close: {
    position: "absolute",
    insetBlockStart: space.s1,
    insetInlineEnd: space.s1,
  },
});

/**
 * Adds and closes toasts: `useToast().add({ title, description })`. A toast
 * of `type: "error"` shows its title in the destructive colour, is announced
 * at once, and stays until dismissed, as a failure mustn't slip by unread;
 * the caller's own `priority` or `timeout` still wins. One with `actionProps`
 * shows a button, and `timeout: 0` keeps it until it is closed.
 */
export function useToast() {
  const manager = BaseToast.useToastManager();

  return useMemo(
    () => ({
      ...manager,
      add: (options: Parameters<typeof manager.add>[0]) =>
        manager.add(
          options.type === "error" ? { priority: "high", timeout: 0, ...options } : options,
        ),
    }),
    [manager],
  );
}

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
        // Base UI hides a high-priority toast, which it announces through an
        // alert of its own, until the stack is reached with F6; till then
        // neither it nor its buttons are tab stops.
        const hidden = props["aria-hidden"] === true;

        return (
          <motion.div
            {...forMotion(props)}
            tabIndex={hidden ? -1 : props.tabIndex}
            className={stylex.props(styles.toast).className}
            // `layout` glides the rest of the stack into a closed toast's place.
            layout
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={exiting ? { opacity: 0, y: 0, scale: 0.97 } : { opacity: 1, y: 0, scale: 1 }}
            transition={{ ...(exiting ? spring.slow.exit : spring.slow), layout: spring.moderate }}
          >
            <HiddenContext value={hidden}>{props.children}</HiddenContext>
          </motion.div>
        );
      }}
    >
      <BaseToast.Title
        {...stylex.props(styles.title, toast.type === "error" && styles.errorTitle)}
      />
      <BaseToast.Description {...stylex.props(styles.description)} />
      {toast.actionProps !== undefined && <ToastAction />}
      <ToastClose />
    </BaseToast.Root>
  ));
}

const HiddenContext = createContext(false);

function ToastAction() {
  const hidden = use(HiddenContext);

  return (
    <BaseToast.Action
      tabIndex={hidden ? -1 : undefined}
      render={<Button size="compact" variant="secondary" xstyle={styles.action} />}
    />
  );
}

function ToastClose() {
  const hidden = use(HiddenContext);

  return (
    <BaseToast.Close
      tabIndex={hidden ? -1 : undefined}
      render={
        <Button variant="ghost" size="icon-compact" aria-label="Close" xstyle={styles.close}>
          <XIcon size={14} />
        </Button>
      }
    />
  );
}
