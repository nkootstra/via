/** The dashboard's frame: the sidebar (a top bar when narrow) and the page. */
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Button,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  NavItem,
  NavList,
  ThemeSwitch,
} from "@via/ui";
import { colors, fonts, space, text } from "@via/ui/tokens.stylex";
import { useSyncExternalStore, type ReactNode } from "react";
import { signOut } from "../api/admin.ts";
import { AccountsIcon, KeyIcon, Mark, ModelsIcon, OverviewIcon, SignOutIcon } from "./icons.tsx";

type Page = "/" | "/accounts" | "/keys" | "/models";

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

/** The dashboard page at `path`, if it is one. */
export const pageAt = (path: string) => pages.find((page) => page.to === path)?.to;

const styles = stylex.create({
  layout: {
    display: "flex",
    flexDirection: { default: "column", "@media (min-width: 800px)": "row" },
    minHeight: "100dvh",
    fontFamily: fonts.sans,
    fontSize: text.body,
    color: colors.foreground,
    backgroundColor: colors.background,
  },
  sidebar: {
    position: { default: "sticky", "@media (min-width: 800px)": "sticky" },
    top: 0,
    zIndex: 10,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: { default: "row", "@media (min-width: 800px)": "column" },
    flexWrap: { default: "wrap", "@media (min-width: 800px)": "nowrap" },
    alignItems: { default: "center", "@media (min-width: 800px)": "stretch" },
    justifyContent: "space-between",
    gap: { default: space.s2, "@media (min-width: 800px)": space.s6 },
    flexShrink: 0,
    width: { default: "100%", "@media (min-width: 800px)": "232px" },
    height: { default: "auto", "@media (min-width: 800px)": "100dvh" },
    paddingBlock: { default: space.s3, "@media (min-width: 800px)": "20px" },
    paddingInline: { default: space.s4, "@media (min-width: 800px)": space.s3 },
    borderColor: colors.border,
    borderStyle: "solid",
    borderWidth: 0,
    borderBottomWidth: { default: 1, "@media (min-width: 800px)": 0 },
    borderRightWidth: { default: 0, "@media (min-width: 800px)": 1 },
    backgroundColor: {
      default: `color-mix(in oklab, ${colors.background} 85%, transparent)`,
      "@media (min-width: 800px)": colors.background,
    },
    backdropFilter: { default: "blur(12px)", "@media (min-width: 800px)": "none" },
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    paddingInline: { default: 0, "@media (min-width: 800px)": space.s2_5 },
    fontSize: "17px",
    letterSpacing: "-0.02em",
    fontVariationSettings: "'wght' 650",
    color: colors.foreground,
    textDecoration: "none",
  },
  wideNav: { flexGrow: 1 },
  narrowNav: {
    order: 3,
    flexBasis: "100%",
    marginInline: `calc(-1 * ${space.s2})`,
  },
  footer: {
    display: "flex",
    flexDirection: { default: "row", "@media (min-width: 800px)": "column" },
    alignItems: { default: "center", "@media (min-width: 800px)": "stretch" },
    gap: space.s2,
  },
  footerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    paddingInline: { default: 0, "@media (min-width: 800px)": space.s1 },
  },
  signOut: { justifyContent: "flex-start" },
  signOutLabel: {
    display: { default: "none", "@media (min-width: 800px)": "inline" },
  },
  main: {
    flexGrow: 1,
    minWidth: 0,
    boxSizing: "border-box",
    paddingBlock: { default: space.s6, "@media (min-width: 800px)": "40px" },
    paddingInline: { default: space.s4, "@media (min-width: 800px)": "48px" },
  },
});

function Pages({ orientation }: { readonly orientation: "vertical" | "horizontal" }) {
  const { pathname } = useLocation();

  return (
    <NavList label="Pages" orientation={orientation}>
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

/** Sign out, once the viewer confirms: signing back in needs the admin key. */
function SignOut() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: signOut,
    onSettled: () => {
      queryClient.clear();
      void navigate({ to: "/sign-in" });
    },
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost-destructive"
            size="compact"
            aria-label="Sign out"
            xstyle={styles.signOut}
          >
            <SignOutIcon size={15} />
            <span {...stylex.props(styles.signOutLabel)}>Sign out</span>
          </Button>
        }
      />
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
  );
}

const wideQuery = "(min-width: 800px)";

const subscribeWide = (onChange: () => void) => {
  const media = matchMedia(wideQuery);
  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
};

/** Whether the sidebar has room; only crossing the breakpoint rerenders. */
const useWide = () =>
  useSyncExternalStore(
    subscribeWide,
    () => matchMedia(wideQuery).matches,
    () => true,
  );

export function Dashboard() {
  const wide = useWide();

  return (
    <div {...stylex.props(styles.layout)}>
      <aside {...stylex.props(styles.sidebar)}>
        <Link to="/" {...stylex.props(styles.brand)}>
          <Mark size={26} />
          via
        </Link>
        <div {...stylex.props(wide ? styles.wideNav : styles.narrowNav)}>
          <Pages orientation={wide ? "vertical" : "horizontal"} />
        </div>
        <div {...stylex.props(styles.footer)}>
          <div {...stylex.props(styles.footerRow)}>
            <ThemeSwitch />
          </div>
          <SignOut />
        </div>
      </aside>
      <main {...stylex.props(styles.main)}>
        <Outlet />
      </main>
    </div>
  );
}
