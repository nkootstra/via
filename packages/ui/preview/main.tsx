/// <reference types="vite/client" />
// The component gallery. Every component in both schemes, side by side, in
// the states worth seeing: hover glides, focus, disabled, loading, errors,
// and the dialogs, menu, toasts and copy feedback a click opens.
import "./preview.css";
import "virtual:via-theme.css";
import * as stylex from "@stylexjs/stylex";
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Badge,
  Button,
  CopyField,
  EmptyState,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Menu,
  Meter,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  NavItem,
  NavList,
  Skeleton,
  Switch,
  SegmentedControl,
  SegmentedItem,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ThemeControl,
  ToastProvider,
  useToast,
  type BadgeColor,
} from "../src/index.ts";
import { XIcon } from "../src/icons.tsx";
import { colors, fonts, space, text, weights } from "../src/tokens.stylex.ts";

const styles = stylex.create({
  page: {
    minHeight: "100vh",
    fontFamily: fonts.sans,
    fontSize: text.body,
    color: colors.foreground,
    backgroundColor: colors.background,
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s4,
    padding: space.s6,
  },
  title: {
    margin: 0,
    fontSize: text.title,
    fontVariationSettings: weights.bold,
  },
  note: {
    margin: 0,
    marginTop: space.s1,
    color: colors.mutedForeground,
  },
  panels: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 520px), 1fr))",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    padding: space.s6,
    color: colors.foreground,
    backgroundColor: colors.background,
  },
  panelTitle: {
    margin: 0,
    fontSize: text.subtitle,
    fontVariationSettings: weights.semibold,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  sectionTitle: {
    margin: 0,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    color: colors.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    maxWidth: "20rem",
  },
  panelBody: {
    paddingTop: space.s3,
    color: colors.mutedForeground,
  },
});

const badgeColors: ReadonlyArray<BadgeColor> = ["gray", "green", "amber", "red", "blue"];

const accounts = [
  { label: "work", state: "available", color: "green" },
  { label: "home", state: "cooling until 14:05", color: "amber" },
  { label: "spare", state: "auth error", color: "red" },
  { label: "old", state: "disabled", color: "gray" },
] as const;

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section {...stylex.props(styles.section)}>
      <h3 {...stylex.props(styles.sectionTitle)}>{title}</h3>
      {children}
    </section>
  );
}

function ToastButtons() {
  const toast = useToast();

  return (
    <div {...stylex.props(styles.row)}>
      <Button
        variant="tertiary"
        onClick={() =>
          toast.add({ title: "Key revoked", description: "Clients using it now get 401." })
        }
      >
        Show a toast
      </Button>
      <Button
        variant="tertiary"
        onClick={() =>
          toast.add({
            type: "error",
            title: "Could not add the account",
            description: "The login expired.",
          })
        }
      >
        Show an error toast
      </Button>
    </div>
  );
}

function Gallery() {
  const [label, setLabel] = useState("work");
  const [enabled, setEnabled] = useState(true);
  const [hours, setHours] = useState("auto");
  const [page, setPage] = useState("Overview");

  return (
    <>
      <Section title="Button">
        <div {...stylex.props(styles.row)}>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="tertiary">Tertiary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button size="icon" variant="ghost" aria-label="Close">
            <XIcon size={16} />
          </Button>
        </div>
        <div {...stylex.props(styles.row)}>
          <Button size="compact">Compact</Button>
          <Button size="compact" variant="tertiary">
            Compact
          </Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
          <Button variant="tertiary" disabled>
            Disabled
          </Button>
        </div>
        <div {...stylex.props(styles.row)}>
          <Button variant="destructive">Revoke key</Button>
          <Button variant="destructive" size="compact">
            Revoke
          </Button>
          <Button variant="destructive" loading>
            Removing
          </Button>
          <Button variant="ghost-destructive" size="compact">
            Sign out
          </Button>
        </div>
      </Section>

      <Section title="Badge">
        <div {...stylex.props(styles.row)}>
          {badgeColors.map((color) => (
            <Badge key={color} color={color}>
              {color}
            </Badge>
          ))}
        </div>
        <div {...stylex.props(styles.row)}>
          {badgeColors.map((color) => (
            <Badge key={color} color={color} variant="dot">
              {color}
            </Badge>
          ))}
        </div>
      </Section>

      <Section title="Field and Input (hover and focus them)">
        <div {...stylex.props(styles.stack)}>
          <Field label="Label">
            <Input value={label} onValueChange={setLabel} placeholder="An account label" />
          </Field>
          <Field label="Admin key" error="That key is wrong">
            <Input type="password" defaultValue="not-the-key" />
          </Field>
          <Field label="Disabled" disabled>
            <Input defaultValue="read only" />
          </Field>
        </div>
      </Section>

      <Section title="Input adornments (one border around icon and text)">
        <div {...stylex.props(styles.stack)}>
          <Input
            type="search"
            aria-label="Search models"
            placeholder="Search 12 models"
            sunken
            leading={
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
                <path d="m16.5 16.5 4 4" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            }
          />
          <Field label="Label">
            <Input
              value={label}
              onValueChange={setLabel}
              trailing={
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label="Clear"
                  onClick={() => setLabel("")}
                >
                  <XIcon size={14} />
                </Button>
              }
            />
          </Field>
        </div>
      </Section>

      <Section title="Tabs (the selection springs, hover glides)">
        <Tabs defaultValue="accounts">
          <TabsList aria-label="Pages">
            <TabItem value="accounts" label="Accounts" />
            <TabItem value="keys" label="Keys" />
            <TabItem value="usage" label="Usage" />
            <TabItem value="pool" label="Pool" />
          </TabsList>
          <TabPanel value="accounts">
            <p {...stylex.props(styles.panelBody)}>Accounts panel</p>
          </TabPanel>
          <TabPanel value="keys">
            <p {...stylex.props(styles.panelBody)}>Keys panel</p>
          </TabPanel>
          <TabPanel value="usage">
            <p {...stylex.props(styles.panelBody)}>Usage panel</p>
          </TabPanel>
          <TabPanel value="pool">
            <p {...stylex.props(styles.panelBody)}>Pool panel</p>
          </TabPanel>
        </Tabs>
      </Section>

      <Section title="SegmentedControl (a choice of one, as Tabs look)">
        <SegmentedControl aria-label="Time format" value={hours} onValueChange={setHours}>
          <SegmentedItem value="auto" label="Automatic" />
          <SegmentedItem value="12h" label="12-hour" />
          <SegmentedItem value="24h" label="24-hour" />
        </SegmentedControl>
      </Section>

      <Section title="Table (move the pointer down the rows)">
        <Table aria-label="Accounts">
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account, index) => (
              <TableRow key={account.label} index={index}>
                <TableCell>{account.label}</TableCell>
                <TableCell>
                  <Badge variant="dot" color={account.color}>
                    {account.state}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="Menu, Dialog, AlertDialog">
        <div {...stylex.props(styles.row)}>
          <Menu>
            <MenuTrigger render={<Button variant="tertiary">Account actions</Button>} />
            <MenuContent>
              <MenuItem label="Rename" />
              <MenuItem label="Disable" />
              <MenuItem label="Log in again" disabled />
              <MenuSeparator />
              <MenuItem label="Remove" icon={<XIcon size={15} />} destructive />
            </MenuContent>
          </Menu>

          <Dialog>
            <DialogTrigger render={<Button variant="tertiary">Rename…</Button>} />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Rename account</DialogTitle>
                <DialogDescription>The label shows in usage and in logs.</DialogDescription>
              </DialogHeader>
              <Field label="Label">
                <Input defaultValue="work" />
              </Field>
              <DialogFooter>
                <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
                <DialogClose render={<Button>Save</Button>} />
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="tertiary">Revoke key…</Button>} />
            <AlertDialogContent>
              <DialogHeader>
                <DialogTitle>Revoke this key?</DialogTitle>
                <DialogDescription>Clients using it stop working at once.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
                <DialogClose render={<Button variant="destructive">Revoke key</Button>} />
              </DialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Section>

      <Section title="NavList (the current page springs, hover glides)">
        <div {...stylex.props(styles.stack)}>
          <NavList label="Pages">
            {["Overview", "Accounts", "Keys", "Models"].map((item) => (
              <NavItem
                key={item}
                label={item}
                current={page === item}
                render={(props) => (
                  <a
                    {...props}
                    href={`#${item}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setPage(item);
                    }}
                  >
                    {props.children}
                  </a>
                )}
              />
            ))}
          </NavList>
        </div>
      </Section>

      <Section title="Switch and Meter">
        <div {...stylex.props(styles.row)}>
          <Switch aria-label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
          <Switch
            aria-label="Disabled switch"
            checked={false}
            onCheckedChange={() => {}}
            disabled
          />
        </div>
        <div {...stylex.props(styles.stack)}>
          <Meter label="5 hours" value={34} detail="Resets in 2 h 10 min" />
          <Meter label="7 days" value={76} detail="Resets Tue 09:00" />
          <Meter label="Monthly" value={96} />
        </div>
      </Section>

      <Section title="Skeleton and EmptyState">
        <div {...stylex.props(styles.stack)}>
          <Skeleton width="60%" />
          <Skeleton />
          <Skeleton width="40%" height="28px" />
        </div>
        <EmptyState
          title="No accounts yet"
          description="Add a ChatGPT account and via starts pooling it."
          action={<Button>Add account</Button>}
        />
      </Section>

      <Section title="Toast">
        <ToastButtons />
      </Section>

      <Section title="CopyField (click to copy)">
        <div {...stylex.props(styles.stack)}>
          <CopyField label="API key" value="via-4f1c2b9e0d7a41e8b6c3" />
        </div>
      </Section>
    </>
  );
}

function Preview() {
  return (
    <ToastProvider>
      <div {...stylex.props(styles.page)}>
        <header {...stylex.props(styles.header)}>
          <div>
            <h1 {...stylex.props(styles.title)}>@via/ui</h1>
            <p {...stylex.props(styles.note)}>
              Press Tab to see focus. Dialogs, menus and toasts open over the page, so they follow
              the page theme on the right, which reloads keep.
            </p>
          </div>
          <ThemeControl aria-label="Theme" />
        </header>
        <div {...stylex.props(styles.panels)}>
          {/* Each panel forces its palette, as the theme control does for the page. */}
          <div data-theme="light" {...stylex.props(styles.panel)}>
            <h2 {...stylex.props(styles.panelTitle)}>Light</h2>
            <Gallery />
          </div>
          <div data-theme="dark" {...stylex.props(styles.panel)}>
            <h2 {...stylex.props(styles.panelTitle)}>Dark</h2>
            <Gallery />
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}

const root = document.getElementById("root");

if (root !== null) createRoot(root).render(<Preview />);
