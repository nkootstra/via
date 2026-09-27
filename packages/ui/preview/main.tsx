/// <reference types="vite/client" />
// The component gallery. Every component in both schemes, side by side, in
// the states worth seeing: hover glides, focus, disabled, loading, errors,
// and the dialogs, menu, toasts and copy feedback a click opens.
import "./preview.css";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTrigger,
  Badge,
  Button,
  CopyField,
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
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
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
  ToastProvider,
  useToast,
  type BadgeColor,
} from "../src/index.ts";
import { XIcon } from "../src/icons.tsx";
import {
  colors,
  darkScheme,
  fonts,
  lightScheme,
  shadows,
  space,
  text,
  weights,
} from "../src/tokens.stylex.ts";

// Forced schemes: the tokens follow the OS, so each panel pins its own.
const lightColors = stylex.createTheme(colors, {
  surface3: lightScheme.surface3,
  surface4: lightScheme.surface4,
  surface5: lightScheme.surface5,
  background: lightScheme.background,
  foreground: lightScheme.foreground,
  muted: lightScheme.muted,
  mutedForeground: lightScheme.mutedForeground,
  accent: lightScheme.accent,
  border: lightScheme.border,
  destructive: lightScheme.destructive,
  destructiveLight: lightScheme.destructiveLight,
  focusRing: "#6B97FF",
  hover: lightScheme.hover,
  active: lightScheme.active,
  backdrop: lightScheme.backdrop,
});

const darkColors = stylex.createTheme(colors, {
  surface3: darkScheme.surface3,
  surface4: darkScheme.surface4,
  surface5: darkScheme.surface5,
  background: darkScheme.background,
  foreground: darkScheme.foreground,
  muted: darkScheme.muted,
  mutedForeground: darkScheme.mutedForeground,
  accent: darkScheme.accent,
  border: darkScheme.border,
  destructive: darkScheme.destructive,
  destructiveLight: darkScheme.destructiveLight,
  focusRing: "#6B97FF",
  hover: darkScheme.hover,
  active: darkScheme.active,
  backdrop: darkScheme.backdrop,
});

const lightShadows = stylex.createTheme(shadows, {
  surface3: lightScheme.shadow3,
  surface4: lightScheme.shadow4,
  surface5: lightScheme.shadow5,
});

const darkShadows = stylex.createTheme(shadows, {
  surface3: darkScheme.shadow3,
  surface4: darkScheme.shadow4,
  surface5: darkScheme.shadow5,
});

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
  lightPanel: { colorScheme: "light" },
  darkPanel: { colorScheme: "dark" },
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
              <MenuItem label="Remove" />
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
                <DialogClose render={<Button>Revoke key</Button>} />
              </DialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
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

type PageScheme = "system" | "light" | "dark";

const pageThemes = {
  system: "",
  light: stylex.props(lightColors, lightShadows).className ?? "",
  dark: stylex.props(darkColors, darkShadows).className ?? "",
} as const;

function isPageScheme(value: string): value is PageScheme {
  return value === "system" || value === "light" || value === "dark";
}

function Preview() {
  const [scheme, setScheme] = useState<PageScheme>("system");

  // Dialogs, menus and toasts portal to <body>, outside the panels, so the
  // page itself carries a scheme for them.
  useEffect(() => {
    document.documentElement.className = pageThemes[scheme];
  }, [scheme]);

  return (
    <ToastProvider>
      <div {...stylex.props(styles.page)}>
        <header {...stylex.props(styles.header)}>
          <div>
            <h1 {...stylex.props(styles.title)}>@via/ui</h1>
            <p {...stylex.props(styles.note)}>
              Press Tab to see focus. Dialogs, menus and toasts open over the page, so they follow
              the page scheme on the right.
            </p>
          </div>
          <Tabs
            value={scheme}
            onValueChange={(value) => {
              if (isPageScheme(value)) setScheme(value);
            }}
          >
            <TabsList aria-label="Page scheme">
              <TabItem value="system" label="System" />
              <TabItem value="light" label="Light" />
              <TabItem value="dark" label="Dark" />
            </TabsList>
          </Tabs>
        </header>
        <div {...stylex.props(styles.panels)}>
          <div {...stylex.props(lightColors, lightShadows, styles.panel, styles.lightPanel)}>
            <h2 {...stylex.props(styles.panelTitle)}>Light</h2>
            <Gallery />
          </div>
          <div {...stylex.props(darkColors, darkShadows, styles.panel, styles.darkPanel)}>
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
