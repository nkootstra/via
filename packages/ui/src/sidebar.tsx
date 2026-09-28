/**
 * Sidebar, ported from Fluid Functionalism's sidebar in its "inset" design
 * (MIT, see NOTICE). On a wide screen the sidebar sits flat on the frame and
 * the page is a raised panel inset beside it; collapsing springs the column
 * away and the panel slides over. Only the trigger and `[` bring it back, and
 * it remembers being collapsed. On a narrow screen it is a drawer.
 */
import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { motion, useReducedMotion } from "motion/react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button } from "./button.tsx";
import { Menu, MenuContent, MenuTrigger } from "./menu.tsx";
import { forMotion } from "./motion-props.ts";
import { spring } from "./springs.ts";
import {
  colors,
  durations,
  fontWeights,
  fonts,
  radii,
  shadows,
  space,
  text,
  weights,
} from "./tokens.stylex.ts";

const WIDTH = 256;

const MOBILE_QUERY = "(max-width: 767px)";

const SHORTCUT = "[";

const STORAGE_KEY = "via.sidebar";

// The column's own spring, Fluid Functionalism's slow tier as the sidebar
// uses it: the widest thing that moves, it lands with a little bounce, and
// collapses on a quicker tween.
const columnSpring = {
  type: "spring",
  duration: 0.24,
  bounce: 0.12,
  exit: { duration: 0.16 },
} as const;

// Private windows and blocked site data make storage throw; the choice then
// lasts only as long as the page.
const storedOpen = () => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "collapsed";
  } catch {
    return true;
  }
};

const storeOpen = (open: boolean) => {
  try {
    if (open) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, "collapsed");
  } catch {
    // Nothing to persist to.
  }
};

const subscribeMobile = (onChange: () => void) => {
  const media = matchMedia(MOBILE_QUERY);
  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
};

/** Whether the sidebar is a drawer; only crossing the breakpoint rerenders. */
const useMobile = () =>
  useSyncExternalStore(
    subscribeMobile,
    () => matchMedia(MOBILE_QUERY).matches,
    () => false,
  );

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

interface SidebarState {
  readonly mobile: boolean;
  /** Whether the wide sidebar is pinned open. */
  readonly open: boolean;
  /** Whether the drawer is open. */
  readonly drawerOpen: boolean;
  readonly setDrawerOpen: (open: boolean) => void;
  readonly toggle: () => void;
  /** The id of what the trigger opens: the sidebar, or the drawer. */
  readonly panelId: string;
}

const SidebarContext = createContext<SidebarState | null>(null);

const useSidebar = () => {
  const state = use(SidebarContext);

  // A sidebar part outside its provider is a programming error, found the
  // first time the page renders.
  if (state === null) throw new Error("Sidebar parts render inside a SidebarProvider.");

  return state;
};

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  wrapper: {
    position: "relative",
    display: "flex",
    width: "100%",
    minHeight: "100dvh",
    fontFamily: fonts.sans,
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.foreground,
    backgroundColor: colors.background,
  },
  shell: {
    position: "sticky",
    top: 0,
    flexShrink: 0,
    height: "100dvh",
    overflow: "hidden",
  },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    boxSizing: "border-box",
    display: "flex",
    width: `${WIDTH}px`,
    paddingBlock: space.s2,
  },
  // The panel lays itself out as flex, which would outrank `hidden`.
  away: { display: "none" },
  sidebar: {
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    width: "100%",
    minHeight: 0,
  },
  // The grab strip on the sidebar's inner edge: a click collapses the sidebar,
  // and a hairline brightens under the pointer.
  rail: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    zIndex: 20,
    width: space.s2,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    cursor: "w-resize",
    outline: "none",
  },
  // Clear through the panel's corner radius, then fading in over 24px.
  railLine: {
    position: "absolute",
    top: space.s2,
    bottom: space.s2,
    right: 0,
    width: space.px,
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":hover")]:
        `color-mix(in oklab, ${colors.foreground} 25%, transparent)`,
    },
    maskImage:
      "linear-gradient(to bottom, transparent 12px, black 36px, black calc(100% - 36px), transparent calc(100% - 12px))",
    transitionProperty: "background-color",
    transitionDuration: durations.fast,
  },
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 40,
    backgroundColor: colors.backdrop,
  },
  drawer: {
    position: "fixed",
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    width: "18rem",
    maxWidth: "calc(100% - 3rem)",
    overflow: "hidden",
    backgroundColor: colors.surface3,
    boxShadow: shadows.surface3,
    color: colors.foreground,
    // Portalled to <body>, so it brings its own font.
    fontFamily: fonts.sans,
    fontSize: text.body,
    outline: "none",
  },
  inset: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    margin: space.s2,
    borderRadius: radii.container,
    backgroundColor: colors.surface2,
    boxShadow: shadows.surface2,
    transitionProperty: "margin",
    transitionDuration: durations.fast,
  },
  // Beside the pinned sidebar the panel gives up its gutter on that side.
  insetBeside: { marginLeft: 0 },
  glyph: {
    display: "flex",
    animationName: fadeIn,
    animationDuration: { default: durations.fast, "@media (prefers-reduced-motion: reduce)": "0s" },
  },
  // The footer's user row: a sidebar row whose avatar and chevron sit on the
  // rows' leading icon and trailing action axes.
  userRow: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    width: "100%",
    height: "32px",
    paddingInline: space.s2,
    borderWidth: 0,
    borderRadius: radii.item,
    fontFamily: "inherit",
    fontSize: text.body,
    color: colors.foreground,
    textAlign: "start",
    // While its menu is open the highlight belongs to the menu's rows.
    backgroundColor: {
      default: "transparent",
      ":hover:not([data-popup-open])": colors.hover,
    },
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
    transitionProperty: "background-color",
    transitionDuration: durations.fast,
  },
  avatar: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
    height: "20px",
    marginInline: "-2px",
    borderRadius: radii.full,
    fontSize: "10px",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.background,
    backgroundColor: colors.foreground,
  },
  userName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  selector: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: space.s6,
    height: space.s6,
    marginInlineStart: "auto",
    marginInlineEnd: "-2px",
    color: colors.mutedForeground,
  },
  header: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: space.s2,
    padding: space.s2,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    padding: space.s2,
    overflowY: "auto",
  },
  footer: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: space.s2,
    marginTop: "auto",
    padding: space.s2,
  },
});

export interface SidebarProviderProps {
  readonly children?: ReactNode;
}

/** Holds the sidebar's state for its parts, and lays the sidebar beside the page. */
export function SidebarProvider({ children }: SidebarProviderProps) {
  const mobile = useMobile();
  const [open, setOpen] = useState(storedOpen);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const panelId = useId();

  const toggle = useCallback(() => {
    if (mobile) {
      setDrawerOpen((was) => !was);

      return;
    }

    setOpen((was) => {
      storeOpen(!was);

      return !was;
    });
  }, [mobile]);

  // The shortcut works wherever focus is, except while typing, and leaves the
  // browser's own ⌘[ and Ctrl+[ alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== SHORTCUT || event.metaKey || event.ctrlKey || event.altKey) return;

      if (typing(event.target)) return;

      event.preventDefault();
      toggle();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  const state = useMemo(
    () => ({
      mobile,
      open,
      drawerOpen: mobile && drawerOpen,
      setDrawerOpen,
      toggle,
      panelId,
    }),
    [mobile, open, drawerOpen, toggle, panelId],
  );

  return (
    <SidebarContext value={state}>
      <div {...stylex.props(styles.wrapper)}>{children}</div>
    </SidebarContext>
  );
}

export interface SidebarProps {
  readonly children?: ReactNode;
}

/** The sidebar: a column beside the page on a wide screen, a drawer on a narrow one. */
export function Sidebar({ children }: SidebarProps) {
  const { mobile } = useSidebar();

  return mobile ? <Drawer>{children}</Drawer> : <Column>{children}</Column>;
}

function Column({ children }: { readonly children?: ReactNode }) {
  const { open, toggle, panelId } = useSidebar();
  const reduceMotion = useReducedMotion() ?? false;

  // Collapsing takes the sidebar away at once while the column springs shut;
  // expanding shows it whole, and the widening column's clip wipes it in.
  // The page's banner: the app's name, its navigation and the account.
  return (
    <motion.header
      data-state={open ? "expanded" : "collapsed"}
      initial={false}
      animate={{ width: open ? WIDTH : 0 }}
      transition={reduceMotion ? { duration: 0 } : open ? columnSpring : columnSpring.exit}
      {...stylex.props(styles.shell)}
    >
      <div id={panelId} hidden={!open} {...stylex.props(styles.panel, !open && styles.away)}>
        <div {...stylex.props(styles.sidebar)}>{children}</div>
        <button
          type="button"
          aria-label="Collapse sidebar"
          tabIndex={-1}
          onClick={toggle}
          {...stylex.props(stylex.defaultMarker(), styles.rail)}
        >
          <span aria-hidden="true" {...stylex.props(styles.railLine)} />
        </button>
      </div>
    </motion.header>
  );
}

interface TransitionState {
  readonly transitionStatus: "starting" | "ending" | "idle" | undefined;
}

function Drawer({ children }: { readonly children?: ReactNode }) {
  const { drawerOpen, setDrawerOpen, panelId } = useSidebar();
  const reduceMotion = useReducedMotion() ?? false;

  // Following a link in the drawer leaves for another page: the drawer goes.
  const onClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a") !== null) {
      setDrawerOpen(false);
    }
  };

  return (
    <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop
          render={(props, state: TransitionState) => {
            const exiting = state.transitionStatus === "ending";

            return (
              <motion.div
                {...forMotion(props)}
                className={stylex.props(styles.backdrop).className}
                initial={{ opacity: 0 }}
                animate={{ opacity: exiting ? 0 : 1 }}
                transition={exiting ? spring.moderate.exit : { duration: spring.moderate.duration }}
              />
            );
          }}
        />
        <Dialog.Popup
          id={panelId}
          aria-label="Sidebar"
          render={(props, state: TransitionState) => {
            const exiting = state.transitionStatus === "ending";

            return (
              <motion.div
                {...forMotion(props)}
                onClick={onClick}
                className={stylex.props(styles.drawer).className}
                initial={{ x: "-100%" }}
                animate={{ x: exiting ? "-100%" : 0 }}
                // Critically damped, so the panel lands without overshooting
                // and showing the page behind its edge.
                transition={
                  reduceMotion ? { duration: 0 } : exiting ? spring.moderate.exit : spring.moderate
                }
              />
            );
          }}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export interface SidebarInsetProps {
  readonly children?: ReactNode;
}

/** The page beside the sidebar. */
export function SidebarInset({ children }: SidebarInsetProps) {
  const { mobile, open } = useSidebar();

  return (
    <div {...stylex.props(styles.inset, !mobile && open && styles.insetBeside)}>{children}</div>
  );
}

type SectionProps = { readonly children?: ReactNode };

export function SidebarHeader({ children }: SectionProps) {
  return <div {...stylex.props(styles.header)}>{children}</div>;
}

/** The sidebar's middle, which scrolls when it runs long. */
export function SidebarContent({ children }: SectionProps) {
  return <div {...stylex.props(styles.content)}>{children}</div>;
}

/** Pinned to the sidebar's bottom. */
export function SidebarFooter({ children }: SectionProps) {
  return <div {...stylex.props(styles.footer)}>{children}</div>;
}

const filled = {
  viewBox: "0 0 24 24",
  fill: "currentColor",
  "aria-hidden": true,
} as const;

/** The sidebar, with an arrow pointing it away: what hiding it does. */
function HideSidebarIcon() {
  return (
    <svg width={16} height={16} {...filled}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M19.25 20H7.5V4H19.25C20.7688 4 22 5.23122 22 6.75V17.25C22 18.7688 20.7688 20 19.25 20ZM15.7803 10.2803C16.0732 9.98744 16.0732 9.51256 15.7803 9.21967C15.4874 8.92678 15.0126 8.92678 14.7197 9.21967L12.4697 11.4697C12.1768 11.7626 12.1768 12.2374 12.4697 12.5303L14.7197 14.7803C15.0126 15.0732 15.4874 15.0732 15.7803 14.7803C16.0732 14.4874 16.0732 14.0126 15.7803 13.7197L14.0607 12L15.7803 10.2803Z"
      />
      <path d="M4.75 4H6V20H4.75C3.23122 20 2 18.7688 2 17.25V6.75C2 5.23122 3.23122 4 4.75 4Z" />
    </svg>
  );
}

/** A window with the sidebar's column outlined: where it comes back. */
function ShowSidebarIcon() {
  return (
    <svg width={16} height={16} {...filled}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 5.5V18.5H19.25C19.9404 18.5 20.5 17.9404 20.5 17.25V6.75C20.5 6.05964 19.9404 5.5 19.25 5.5H9ZM2 6.75C2 5.23122 3.23122 4 4.75 4H19.25C20.7688 4 22 5.23122 22 6.75V17.25C22 18.7688 20.7688 20 19.25 20H4.75C3.23122 20 2 18.7688 2 17.25V6.75Z"
      />
    </svg>
  );
}

/**
 * Hides or shows the sidebar: on a wide screen collapses or expands it, on a
 * narrow one closes or opens the drawer. Its name and glyph say which a press
 * does, and the new glyph fades in.
 */
export function SidebarTrigger() {
  const { mobile, open, drawerOpen, toggle, panelId } = useSidebar();
  const expanded = mobile ? drawerOpen : open;
  const label = expanded ? "Hide sidebar" : "Show sidebar";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={panelId}
      aria-keyshortcuts={SHORTCUT}
      title={`${label} (${SHORTCUT})`}
      onClick={toggle}
    >
      <span key={label} {...stylex.props(styles.glyph)}>
        {expanded ? <HideSidebarIcon /> : <ShowSidebarIcon />}
      </span>
    </Button>
  );
}

/** Fluid Functionalism's selector glyph (Untitled UI's chevron-selector-vertical). */
function SelectorIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
    </svg>
  );
}

export interface SidebarUserMenuProps {
  /** Who is signed in; its first letter is the avatar. */
  readonly name: string;
  /** The menu's items. */
  readonly children?: ReactNode;
}

/**
 * The footer's user row: the signed-in user's avatar and name, opening their
 * menu upward on the sidebar's grid.
 */
export function SidebarUserMenu({ name, children }: SidebarUserMenuProps) {
  return (
    <Menu>
      <MenuTrigger
        render={(props) => (
          <button type="button" {...props} {...stylex.props(styles.userRow)}>
            <span aria-hidden="true" {...stylex.props(styles.avatar)}>
              {name.slice(0, 1).toUpperCase()}
            </span>
            <span {...stylex.props(styles.userName)}>{name}</span>
            <span {...stylex.props(styles.selector)}>
              <SelectorIcon />
            </span>
          </button>
        )}
      />
      <MenuContent side="top" fitAnchor>
        {children}
      </MenuContent>
    </Menu>
  );
}
