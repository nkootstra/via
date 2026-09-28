/** The dashboard's frame: the sidebar (a drawer when narrow) and the page. */
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogContent,
  Button,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  MenuItem,
  MenuLinkItem,
  MenuSeparator,
  NavItem,
  NavList,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  SidebarUserMenu,
} from "@via/ui";
import { colors, durations, radii, space, text } from "@via/ui/tokens.stylex";
import { useEffect, useState, type ReactNode } from "react";
import { signOut } from "../api/admin.ts";
import {
  AccountsIcon,
  KeyIcon,
  Mark,
  ModelsIcon,
  OverviewIcon,
  SettingsIcon,
  SignOutIcon,
} from "./icons.tsx";

type Page = "/" | "/accounts" | "/keys" | "/models" | "/settings";

const pages: ReadonlyArray<{
  readonly to: Page;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { to: "/", label: "Overview", icon: <OverviewIcon /> },
  { to: "/accounts", label: "Accounts", icon: <AccountsIcon /> },
  { to: "/keys", label: "Keys", icon: <KeyIcon /> },
  { to: "/models", label: "Models", icon: <ModelsIcon /> },
];

/** The dashboard page at `path`, if it is one: a page in the navigation, or the settings. */
export const pageAt = (path: string): Page | undefined =>
  path === "/settings" ? path : pages.find((page) => page.to === path)?.to;

const styles = stylex.create({
  // Off the top of the page until a keyboard reaches it: the first stop on Tab.
  skip: {
    position: "absolute",
    top: space.s2,
    left: space.s2,
    zIndex: 60,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderRadius: radii.item,
    fontSize: text.body,
    textDecoration: "none",
    color: colors.background,
    backgroundColor: colors.foreground,
    outline: "none",
    boxShadow: `0 0 0 1px ${colors.background}, 0 0 0 2px ${colors.focusRing}`,
    transform: { default: "translateY(calc(-100% - 16px))", ":focus": "none" },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    height: "32px",
    paddingInline: space.s1_5,
    borderRadius: radii.item,
    outline: {
      default: "none",
      ":focus-visible": `1px solid ${colors.focusRing}`,
    },
    outlineOffset: "1px",
    // Dims under a pointer that can hover, so it reads as the way home.
    opacity: { default: 1, "@media (hover: hover)": { ":hover": 0.7 } },
    transitionProperty: "opacity",
    transitionDuration: durations.fast,
  },
  // In the sidebar's column it keeps to the start, rather than stretching across.
  headerBrand: { alignSelf: "flex-start" },
  // On a narrow screen the brand rides the top bar, beside the drawer's trigger.
  topBrand: {
    display: { default: "flex", "@media (min-width: 768px)": "none" },
  },
  // On a narrow screen it stays at the top as the page scrolls, so the drawer is always in reach.
  topbar: {
    position: { default: "sticky", "@media (min-width: 768px)": "static" },
    top: "env(safe-area-inset-top, 0px)",
    zIndex: 10,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1,
    height: "48px",
    paddingInline: space.s1_5,
    backgroundColor: colors.surface2,
  },
  main: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    outline: "none",
  },
  page: {
    boxSizing: "border-box",
    paddingTop: { default: space.s2, "@media (min-width: 768px)": space.s4 },
    paddingBottom: { default: space.s6, "@media (min-width: 768px)": "40px" },
    paddingInline: { default: space.s4, "@media (min-width: 768px)": "48px" },
  },
});

function Brand({ xstyle }: { readonly xstyle?: stylex.StyleXStyles }) {
  return (
    <Link to="/" aria-label="via" {...stylex.props(styles.brand, xstyle)}>
      <Mark size={24} />
    </Link>
  );
}

function Pages() {
  const { pathname } = useLocation();

  return (
    <NavList label="Pages">
      {pages.map((page) => (
        <NavItem
          key={page.to}
          label={page.label}
          icon={page.icon}
          current={pageAt(pathname) === page.to}
          render={(props) => <Link to={page.to} {...props} />}
        />
      ))}
    </NavList>
  );
}

/**
 * The admin's menu in the sidebar's footer: the settings, and signing out
 * once the viewer confirms, since signing back in needs the admin key.
 */
function AccountMenu() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const mutation = useMutation({
    mutationFn: signOut,
    onSettled: () => {
      queryClient.clear();
      void navigate({ to: "/sign-in" });
    },
  });

  return (
    <>
      <SidebarUserMenu name="Admin">
        <MenuLinkItem
          label="Settings"
          icon={<SettingsIcon size={16} />}
          render={(props) => <Link to="/settings" {...props} />}
        />
        <MenuSeparator />
        <MenuItem
          label="Sign out…"
          destructive
          icon={<SignOutIcon size={16} />}
          onClick={() => setConfirming(true)}
        />
      </SidebarUserMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <DialogHeader>
            <DialogTitle>Sign out of via?</DialogTitle>
            <DialogDescription>You'll need the admin key to sign in again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
            <Button
              variant="destructive"
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              <SignOutIcon size={15} />
              Sign out
            </Button>
          </DialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * After a move to another page, focus goes to its heading, so a keyboard
 * starts from the top of it and a screen reader announces it. The first
 * page shown keeps the browser's focus.
 */
function useFocusOnNavigation() {
  const router = useRouter();

  useEffect(
    () =>
      router.subscribe("onResolved", ({ fromLocation, pathChanged }) => {
        if (fromLocation === undefined || !pathChanged) return;

        document.querySelector<HTMLElement>("#main h1")?.focus({ preventScroll: true });
      }),
    [router],
  );
}

export function Dashboard() {
  useFocusOnNavigation();

  return (
    <>
      <a
        href="#main"
        onClick={(event) => {
          // Focus moves to the page without the router seeing a new location.
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        {...stylex.props(styles.skip)}
      >
        Skip to content
      </a>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <Brand xstyle={styles.headerBrand} />
          </SidebarHeader>
          <SidebarContent>
            <Pages />
          </SidebarContent>
          <SidebarFooter>
            <AccountMenu />
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <main id="main" tabIndex={-1} {...stylex.props(styles.main)}>
            <div {...stylex.props(styles.topbar)}>
              <SidebarTrigger />
              <Brand xstyle={styles.topBrand} />
            </div>
            <div {...stylex.props(styles.page)}>
              <Outlet />
            </div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </>
  );
}
