import * as stylex from "@stylexjs/stylex";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogContent,
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
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from "@via/ui";
import { colors, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { useState } from "react";
import { createKey, keysQuery, renameKey, revokeKey } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import type { Key } from "../../api/types.ts";
import { KeyIcon, PlusIcon, TrashIcon } from "../../components/icons.tsx";
import { Page, Panel, VisuallyHidden } from "../../components/page.tsx";
import { RenameDialog } from "../../components/rename-dialog.tsx";
import { RowActions } from "../../components/row-actions.tsx";
import { formatDate, formatTimestamp, timeAgo, useNow } from "../../lib/time.ts";

export const Route = createFileRoute("/_app/keys")({
  head: () => ({ meta: [{ title: "Keys · via" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(keysQuery),
  pendingComponent: KeysLoading,
  component: Keys,
});

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  name: {
    display: "flex",
    alignItems: "center",
    gap: space.s2_5,
    fontVariationSettings: weights.medium,
    color: colors.foreground,
  },
  keyIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    borderRadius: radii.item,
    backgroundColor: colors.muted,
    color: colors.mutedForeground,
  },
  id: {
    fontFamily: fonts.mono,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  date: {
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  // The menu's button sits at the table's right edge.
  actions: {
    display: "flex",
    justifyContent: "flex-end",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
  loading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  warning: {
    display: "flex",
    gap: space.s2,
    marginTop: space.s4,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderRadius: radii.item,
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.foreground,
    backgroundColor: "color-mix(in oklab, #f59e0b 12%, transparent)",
    boxShadow: "inset 0 0 0 1px color-mix(in oklab, #f59e0b 30%, transparent)",
  },
  usage: {
    marginTop: space.s3,
    marginBottom: 0,
    fontSize: text.caption,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: "0.95em",
  },
});

/** Names a new key, then shows it the one time via ever returns it. */
function CreateKeyDialog({ onClose }: { readonly onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [taken, setTaken] = useState<string | undefined>(undefined);

  const mutation = useMutation({
    mutationFn: () => createKey(name.trim()),
    onSuccess: (outcome) => {
      if (!outcome.created) return setTaken(outcome.duplicate);

      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });

  const created = mutation.data?.created === true ? mutation.data : undefined;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size={created === undefined ? "sm" : "lg"}>
        {created === undefined ? (
          <form
            {...stylex.props(styles.form)}
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create a key</DialogTitle>
              <DialogDescription>
                Clients send it as their OpenAI API key. Name it after the client that uses it.
              </DialogDescription>
            </DialogHeader>
            <Field
              label="Name"
              error={taken === undefined ? undefined : `A key named "${taken}" already exists.`}
            >
              <Input
                value={name}
                onValueChange={(value) => {
                  setName(value);
                  setTaken(undefined);
                }}
                placeholder="laptop, ci, cursor…"
                required
              />
            </Field>
            {mutation.error !== null && (
              <p role="alert" {...stylex.props(styles.usage)}>
                {mutation.error.message}
              </p>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
              <Button type="submit" loading={mutation.isPending} disabled={name.trim() === ""}>
                Create key
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Your new key: {created.name}</DialogTitle>
              <DialogDescription>
                Copy it now and put it in the client's settings.
              </DialogDescription>
            </DialogHeader>
            <CopyField label="API key" value={created.key} />
            <div role="note" {...stylex.props(styles.warning)}>
              You won't see this key again. via stores only a hash of it; if you lose it, revoke it
              and create another.
            </div>
            <p {...stylex.props(styles.usage)}>
              Point the client at this server's <span {...stylex.props(styles.code)}>/v1</span>{" "}
              endpoint and use the key as its API key.
            </p>
            <DialogFooter>
              <DialogClose render={<Button>Done</Button>} />
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ apiKey, onClose }: { readonly apiKey: Key; readonly onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const mutation = useMutation({
    mutationFn: () => revokeKey(apiKey.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
      toast.add({ title: "Key revoked", description: `Clients using ${apiKey.name} now get 401.` });
      onClose();
    },
    onError: (error) =>
      toast.add({ type: "error", title: "Couldn't revoke", description: error.message }),
  });

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {apiKey.name}?</DialogTitle>
          <DialogDescription>
            Clients using it stop working at once. This can't be undone.
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
            Revoke key
          </Button>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** When a key was last used, "3 min ago", ticking; the full time on hover. */
function LastUsed({ at }: { readonly at: string | null }) {
  // A minute is the finest step "min ago" shows.
  const now = useNow(60_000);

  if (at === null) return <span {...stylex.props(styles.date)}>Never</span>;

  return (
    <time dateTime={at} title={formatTimestamp(at)} {...stylex.props(styles.date)}>
      {timeAgo(at, now)}
    </time>
  );
}

type Open =
  | { readonly dialog: "create" }
  | { readonly dialog: "rename" | "revoke"; readonly key: Key }
  | null;

const title = "Keys";

const description = "The API keys clients use to call via. Each is shown once, when you create it.";

function KeysLoading() {
  return (
    <Page title={title} description={description}>
      <Panel>
        <div aria-busy="true" aria-label="Loading keys" {...stylex.props(styles.loading)}>
          <Skeleton height="20px" />
          <Skeleton height="20px" />
        </div>
      </Panel>
    </Page>
  );
}

function Keys() {
  // While via pushes the state, the keys needn't be asked for.
  const live = useLiveOptions();
  const keys = useSuspenseQuery({ ...keysQuery, ...live });
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const list = keys.data;

  const createButton = (
    <Button onClick={() => setOpen({ dialog: "create" })}>
      <PlusIcon size={15} />
      Create key
    </Button>
  );

  return (
    <Page
      title={title}
      description={description}
      actions={list.length > 0 ? createButton : undefined}
    >
      {list.length === 0 ? (
        <EmptyState
          icon={<KeyIcon size={18} />}
          title="No keys yet"
          description="Create a key for each client that talks to via, so you can revoke one without the others."
          action={createButton}
        />
      ) : (
        <Panel flush>
          <div {...stylex.props(styles.scroll)}>
            <Table aria-label="Keys">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead secondary>Id</TableHead>
                  <TableHead secondary>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>
                    <VisuallyHidden>Actions</VisuallyHidden>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((key, index) => (
                  <TableRow key={key.id} index={index}>
                    <TableCell>
                      <span {...stylex.props(styles.name)}>
                        <span aria-hidden="true" {...stylex.props(styles.keyIcon)}>
                          <KeyIcon size={13} />
                        </span>
                        {key.name}
                      </span>
                    </TableCell>
                    <TableCell secondary>
                      <span {...stylex.props(styles.id)}>{key.id}</span>
                    </TableCell>
                    <TableCell secondary>
                      <span {...stylex.props(styles.date)}>{formatDate(key.createdAt)}</span>
                    </TableCell>
                    <TableCell>
                      <LastUsed at={key.lastUsedAt} />
                    </TableCell>
                    <TableCell>
                      <div {...stylex.props(styles.actions)}>
                        <RowActions
                          name={key.name}
                          remove="Revoke"
                          onRename={() => setOpen({ dialog: "rename", key })}
                          onRemove={() => setOpen({ dialog: "revoke", key })}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
      )}

      {open?.dialog === "create" && <CreateKeyDialog onClose={close} />}
      {open?.dialog === "rename" && (
        <RenameDialog
          thing="Key"
          name={open.key.name}
          field="Name"
          description="Clients keep using the same key; only its name changes."
          rename={(name) => renameKey(open.key.id, name)}
          onRenamed={() => void queryClient.invalidateQueries({ queryKey: ["keys"] })}
          onClose={close}
        />
      )}
      {open?.dialog === "revoke" && <RevokeDialog apiKey={open.key} onClose={close} />}
    </Page>
  );
}
