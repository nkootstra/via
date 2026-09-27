import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogContent,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from "@via/ui";
import { colors, text, weights } from "@via/ui/tokens.stylex";
import { useState } from "react";
import {
  accountsQuery,
  opencodeGoQuery,
  removeAccount,
  updateAccount,
  warm,
} from "../../api/admin.ts";
import type { Account } from "../../api/types.ts";
import { useAddAccount } from "../../components/add-account.tsx";
import {
  AccountsIcon,
  CodexIcon,
  MoreIcon,
  PlusIcon,
  ProviderLogo,
  TrashIcon,
} from "../../components/icons.tsx";
import { OpencodeGoAccounts } from "../../components/opencode-go-accounts.tsx";
import { Page, Panel, Section, VisuallyHidden } from "../../components/page.tsx";
import { formatDate } from "../../lib/time.ts";

export const Route = createFileRoute("/_app/accounts")({
  head: () => ({ meta: [{ title: "Accounts · via" }] }),
  loader: ({ context }) => {
    warm(context.queryClient, accountsQuery);
    warm(context.queryClient, opencodeGoQuery);
  },
  component: Accounts,
});

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  who: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
  },
  label: {
    fontVariationSettings: weights.medium,
    color: colors.foreground,
  },
  email: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  date: {
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  actions: {
    width: "1%",
    textAlign: "right",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
});

function RenameDialog({
  account,
  onClose,
}: {
  readonly account: Account;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState(account.label);

  const mutation = useMutation({
    mutationFn: () => updateAccount(account.id, { label: label.trim() }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["pool"] });
      toast.add({ title: "Account renamed", description: `It's now called ${updated.label}.` });
      onClose();
    },
    onError: (error) =>
      toast.add({ type: "error", title: "Couldn't rename", description: error.message }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename {account.label}</DialogTitle>
            <DialogDescription>
              The label shows in usage, in the pool and in logs.
            </DialogDescription>
          </DialogHeader>
          <Field label="Label">
            <Input value={label} onValueChange={setLabel} required />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
            <Button
              type="submit"
              loading={mutation.isPending}
              disabled={label.trim() === "" || label.trim() === account.label}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  account,
  onClose,
}: {
  readonly account: Account;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const mutation = useMutation({
    mutationFn: () => removeAccount(account.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["pool"] });
      toast.add({ title: "Account removed", description: `via no longer uses ${account.label}.` });
      onClose();
    },
    onError: (error) =>
      toast.add({ type: "error", title: "Couldn't remove", description: error.message }),
  });

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <DialogHeader>
          <DialogTitle>Remove {account.label}?</DialogTitle>
          <DialogDescription>
            via stops handing it out and forgets its tokens. You can add it again with a new login.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
          <Button
            variant="destructive"
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            <TrashIcon size={15} />
            Remove account
          </Button>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Open = { readonly dialog: "rename" | "remove"; readonly account: Account } | null;

function Accounts() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const accounts = useQuery(accountsQuery);
  const [open, setOpen] = useState<Open>(null);
  const add = useAddAccount();

  const toggle = useMutation({
    mutationFn: (account: Account) => updateAccount(account.id, { enabled: !account.enabled }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["pool"] });
      toast.add({
        title: updated.enabled ? "Account enabled" : "Account disabled",
        description: updated.enabled
          ? `via hands ${updated.label} out again.`
          : `via stops handing ${updated.label} out.`,
      });
    },
    onError: (error) =>
      toast.add({ type: "error", title: "Couldn't change it", description: error.message }),
  });

  const close = () => setOpen(null);

  const addButton = (
    <Button onClick={add.open}>
      <PlusIcon size={15} />
      Add account
    </Button>
  );

  const list = accounts.data ?? [];

  return (
    <Page
      title="Accounts"
      description="The ChatGPT accounts and opencode Go keys via pools. Disable one to keep it out of rotation without losing it."
      actions={addButton}
    >
      <Section title="Codex" icon={<CodexIcon size={16} />}>
        {accounts.isPending ? (
          <Panel>
            <div {...stylex.props(styles.who)} aria-busy="true" aria-label="Loading accounts">
              <Skeleton height="20px" />
              <Skeleton height="20px" />
              <Skeleton height="20px" />
            </div>
          </Panel>
        ) : list.length === 0 ? (
          <EmptyState
            icon={<AccountsIcon size={18} />}
            title="No accounts yet"
            description="Add a ChatGPT account with a device login. via keeps its tokens fresh from then on."
            action={addButton}
          />
        ) : (
          <Panel flush>
            <div {...stylex.props(styles.scroll)}>
              <Table aria-label="Accounts">
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead>
                      <VisuallyHidden>Actions</VisuallyHidden>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((account, index) => (
                    <TableRow key={account.id} index={index}>
                      <TableCell>
                        <div {...stylex.props(styles.who)}>
                          <span {...stylex.props(styles.label)}>{account.label}</span>
                          <span {...stylex.props(styles.email)}>{account.email}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge>{account.plan}</Badge>
                      </TableCell>
                      <TableCell>
                        <Switch
                          aria-label={`${account.label} enabled`}
                          checked={account.enabled}
                          disabled={toggle.isPending && toggle.variables.id === account.id}
                          onCheckedChange={() => toggle.mutate(account)}
                        />
                      </TableCell>
                      <TableCell>
                        <span {...stylex.props(styles.date)}>{formatDate(account.createdAt)}</span>
                      </TableCell>
                      <TableCell>
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-compact"
                                aria-label={`Actions for ${account.label}`}
                              >
                                <MoreIcon size={16} />
                              </Button>
                            }
                          />
                          <MenuContent>
                            <MenuItem
                              label="Rename…"
                              onClick={() => setOpen({ dialog: "rename", account })}
                            />
                            <MenuSeparator />
                            <MenuItem
                              label="Remove…"
                              icon={<TrashIcon size={15} />}
                              destructive
                              onClick={() => setOpen({ dialog: "remove", account })}
                            />
                          </MenuContent>
                        </Menu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Panel>
        )}
      </Section>

      <Section title="opencode Go" icon={<ProviderLogo name="opencode-go" size={16} />}>
        <OpencodeGoAccounts addButton={addButton} />
      </Section>

      {add.dialog}
      {open?.dialog === "rename" && <RenameDialog account={open.account} onClose={close} />}
      {open?.dialog === "remove" && <RemoveDialog account={open.account} onClose={close} />}
    </Page>
  );
}
