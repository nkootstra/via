import * as stylex from "@stylexjs/stylex";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogContent,
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
import { colors, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { Schema } from "effect";
import { useEffect, useEffectEvent, useState } from "react";
import {
  accountsQuery,
  loginStatus,
  removeAccount,
  startLogin,
  updateAccount,
} from "../../api/admin.ts";
import type { Account, StartedLogin } from "../../api/types.ts";
import { AccountsIcon, ExternalIcon, MoreIcon, PlusIcon } from "../../components/icons.tsx";
import { Page, Panel } from "../../components/page.tsx";
import { formatDate } from "../../lib/time.ts";

const Search = Schema.Struct({ add: Schema.optional(Schema.Boolean) });

export const Route = createFileRoute("/_app/accounts")({
  validateSearch: Schema.toStandardSchemaV1(Search),
  head: () => ({ meta: [{ title: "Accounts · via" }] }),
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
  code: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: "20px",
    paddingInline: space.s4,
    marginBottom: space.s4,
    borderRadius: radii.container,
    backgroundColor: colors.muted,
  },
  userCode: {
    fontFamily: fonts.mono,
    fontSize: "30px",
    letterSpacing: "0.12em",
    fontVariationSettings: weights.semibold,
    color: colors.foreground,
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    margin: 0,
    paddingLeft: "18px",
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  waiting: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    marginTop: space.s4,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  pulse: {
    width: "8px",
    height: "8px",
    borderRadius: radii.full,
    backgroundColor: "#3b82f6",
    animationName: stylex.keyframes({
      "0%, 100%": { opacity: 1, transform: "scale(1)" },
      "50%": { opacity: 0.35, transform: "scale(0.8)" },
    }),
    animationDuration: "1.4s",
    animationIterationCount: "infinite",
  },
  error: {
    margin: 0,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderRadius: radii.item,
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.foreground,
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 10%, transparent)`,
  },
  // A link dressed as the primary button: it opens OpenAI's page in a new tab.
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    height: space.control,
    paddingInline: space.s4,
    borderRadius: radii.item,
    fontSize: text.body,
    textDecoration: "none",
    whiteSpace: "nowrap",
    color: colors.background,
    backgroundColor: {
      default: colors.foreground,
      ":hover": `color-mix(in oklab, ${colors.foreground} 90%, ${colors.background})`,
    },
    outline: "none",
    boxShadow: {
      default: null,
      ":focus-visible": `0 0 0 1px ${colors.background}, 0 0 0 2px ${colors.focusRing}`,
    },
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
          <Button loading={mutation.isPending} onClick={() => mutation.mutate()}>
            Remove account
          </Button>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A device-code login: the code to enter, then polling every 2 s until the account is added. */
function AddAccountDialog({
  start,
  onClose,
}: {
  readonly start: UseMutationResult<StartedLogin, Error, void>;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const login = start.data;

  const status = useQuery({
    queryKey: ["login", login?.id],
    queryFn: () => loginStatus(login?.id ?? ""),
    enabled: login !== undefined,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 2_000 : false),
    gcTime: 0,
  });

  const outcome = status.data;

  const added = useEffectEvent((account: Account) => {
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["pool"] });
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
    toast.add({ title: "Account added", description: `${account.label} is in the pool.` });
    onClose();
  });

  useEffect(() => {
    if (outcome?.status === "added") added(outcome.account);
  }, [outcome]);

  const failed =
    outcome?.status === "failed" ? outcome.error : (start.error?.message ?? status.error?.message);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add a ChatGPT account</DialogTitle>
          <DialogDescription>
            Sign in to ChatGPT in another tab and enter this code. via adds the account as soon as
            you approve it.
          </DialogDescription>
        </DialogHeader>

        {failed !== undefined ? (
          <p role="alert" {...stylex.props(styles.error)}>
            The login didn't go through: {failed}
          </p>
        ) : login === undefined ? (
          <div {...stylex.props(styles.code)}>
            <Skeleton width="60%" height="36px" />
            <Skeleton width="80%" height="36px" />
          </div>
        ) : (
          <>
            <div {...stylex.props(styles.code)}>
              <span aria-label="Your code" {...stylex.props(styles.userCode)}>
                {login.userCode}
              </span>
              <CopyField label="Code" value={login.userCode} />
            </div>
            <ol {...stylex.props(styles.steps)}>
              <li>Open the sign-in page and log in to the ChatGPT account to add.</li>
              <li>Enter the code above and approve the request.</li>
            </ol>
            <output {...stylex.props(styles.waiting)}>
              <span aria-hidden="true" {...stylex.props(styles.pulse)} />
              Waiting for you to approve…
            </output>
          </>
        )}

        <DialogFooter>
          <DialogClose
            render={<Button variant="tertiary">{failed === undefined ? "Cancel" : "Close"}</Button>}
          />
          {failed !== undefined ? (
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              Try again
            </Button>
          ) : (
            login !== undefined && (
              <a
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
                {...stylex.props(styles.link)}
              >
                Open sign-in page
                <ExternalIcon size={14} />
              </a>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Open =
  | { readonly dialog: "rename" | "remove"; readonly account: Account }
  | { readonly dialog: "add" }
  | null;

function Accounts() {
  const { add } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const accounts = useQuery(accountsQuery);
  // Arriving from the overview's call to action opens the login at once.
  const [open, setOpen] = useState<Open>(add === true ? { dialog: "add" } : null);
  const start = useMutation({ mutationFn: startLogin });
  const startOnArrival = useEffectEvent(() => start.mutate());

  useEffect(() => {
    if (add === true) startOnArrival();
  }, [add]);

  const addAccount = () => {
    start.mutate();
    setOpen({ dialog: "add" });
  };

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

  const close = () => {
    setOpen(null);

    if (add === true) void navigate({ to: "/accounts", search: {}, replace: true });
  };

  const addButton = (
    <Button onClick={addAccount}>
      <PlusIcon size={15} />
      Add account
    </Button>
  );

  const list = accounts.data ?? [];

  return (
    <Page
      title="Accounts"
      description="The ChatGPT accounts via pools. Disable one to keep it out of rotation without losing its login."
      actions={list.length > 0 ? addButton : undefined}
    >
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
                    <span {...stylex.props(styles.email)}>Actions</span>
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

      {open?.dialog === "add" && <AddAccountDialog start={start} onClose={close} />}
      {open?.dialog === "rename" && <RenameDialog account={open.account} onClose={close} />}
      {open?.dialog === "remove" && <RemoveDialog account={open.account} onClose={close} />}
    </Page>
  );
}
