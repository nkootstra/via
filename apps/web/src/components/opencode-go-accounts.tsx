import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogContent,
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
import { colors, fonts, space, text, weights } from "@via/ui/tokens.stylex";
import { type ReactNode, useState } from "react";
import { opencodeGoQuery, removeOpencodeGo, updateOpencodeGo } from "../api/admin.ts";
import type { OpencodeGoAccount } from "../api/types.ts";
import { formatDate } from "../lib/time.ts";
import { MoreIcon, ProviderLogo } from "./icons.tsx";
import { Panel, VisuallyHidden } from "./page.tsx";

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
  note: {
    maxWidth: "46ch",
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.mutedForeground,
  },
  key: {
    fontFamily: fonts.mono,
    whiteSpace: "nowrap",
  },
  date: {
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
  loading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
});

/** Fetches the opencode Go accounts and the pool again, after a change to one. */
function useChanged() {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: ["opencode-go"] });
    void queryClient.invalidateQueries({ queryKey: ["pool"] });
  };
}

function RenameDialog({
  account,
  onClose,
}: {
  readonly account: OpencodeGoAccount;
  readonly onClose: () => void;
}) {
  const changed = useChanged();
  const toast = useToast();
  const [label, setLabel] = useState(account.label);

  const mutation = useMutation({
    mutationFn: () => updateOpencodeGo(account.id, { label: label.trim() }),
    onSuccess: (updated) => {
      changed();
      toast.add({ title: "Key renamed", description: `It's now called ${updated.label}.` });
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
  readonly account: OpencodeGoAccount;
  readonly onClose: () => void;
}) {
  const changed = useChanged();
  const toast = useToast();

  const mutation = useMutation({
    mutationFn: () => removeOpencodeGo(account.id),
    onSuccess: () => {
      changed();
      toast.add({ title: "Key removed", description: `via no longer uses ${account.label}.` });
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
            via stops handing it out and forgets the key. You can add it again by pasting it.
            {account.environmentVariable !== undefined &&
              ` While ${account.environmentVariable} is set, via adds it again when it restarts.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
          <Button loading={mutation.isPending} onClick={() => mutation.mutate()}>
            Remove key
          </Button>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Open = {
  readonly dialog: "rename" | "remove";
  readonly account: OpencodeGoAccount;
} | null;

/**
 * The opencode Go keys via pools, as a table: each one's label, its key's last
 * four characters, whether it is enabled and when it was added, with renaming
 * and removing it. `addButton` offers to add the first one.
 */
export function OpencodeGoAccounts({ addButton }: { readonly addButton: ReactNode }) {
  const changed = useChanged();
  const toast = useToast();
  const accounts = useQuery(opencodeGoQuery);
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);

  const toggle = useMutation({
    mutationFn: (account: OpencodeGoAccount) =>
      updateOpencodeGo(account.id, { enabled: !account.enabled }),
    onSuccess: (updated) => {
      changed();
      toast.add({
        title: updated.enabled ? "Key enabled" : "Key disabled",
        description: updated.enabled
          ? `via hands ${updated.label} out again.`
          : `via stops handing ${updated.label} out.`,
      });
    },
    onError: (error) =>
      toast.add({ type: "error", title: "Couldn't change it", description: error.message }),
  });

  if (accounts.isPending) {
    return (
      <Panel>
        <div
          {...stylex.props(styles.loading)}
          aria-busy="true"
          aria-label="Loading opencode Go keys"
        >
          <Skeleton height="20px" />
          <Skeleton height="20px" />
        </div>
      </Panel>
    );
  }

  const list = accounts.data ?? [];

  if (list.length === 0) {
    return (
      <EmptyState
        icon={<ProviderLogo name="opencode-go" size={18} />}
        title="No opencode Go keys yet"
        description="Paste an opencode Go API key, and via pools it next to your others."
        action={addButton}
      />
    );
  }

  return (
    <Panel flush>
      <div {...stylex.props(styles.scroll)}>
        <Table aria-label="opencode Go keys">
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Key</TableHead>
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
                    {account.environmentVariable !== undefined && (
                      <span {...stylex.props(styles.note)}>
                        Imported from {account.environmentVariable}, which is deprecated. Remove the
                        variable; via keeps this key.
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <span {...stylex.props(styles.key)}>{account.key}</span>
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
      {open?.dialog === "rename" && <RenameDialog account={open.account} onClose={close} />}
      {open?.dialog === "remove" && <RemoveDialog account={open.account} onClose={close} />}
    </Panel>
  );
}
