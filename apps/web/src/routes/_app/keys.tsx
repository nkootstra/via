import * as stylex from "@stylexjs/stylex";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import {
  actionsColumn,
  Button,
  Callout,
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
  MenuItem,
  MenuSeparator,
  RowActions,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from "@via/ui";
import { colors, fonts, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { type RefObject, useRef, useState } from "react";
import { createKey, keysQuery, renameKey, revokeKey } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import type { Key } from "../../api/types.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { Day } from "../../components/day.tsx";
import { EditIcon, KeyIcon, PlusIcon, TrashIcon } from "../../components/icons.tsx";
import { Page, Panel, usePageHeading } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";
import { RenameDialog } from "../../components/rename-dialog.tsx";
import { useRowDialog } from "../../components/row-dialog.ts";
import { timeAgo, useNow } from "../../lib/time.ts";

export const Route = createFileRoute("/_app/keys")({
  head: () => ({ meta: [{ title: "Keys · via" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(keysQuery),
  pendingComponent: KeysLoading,
  errorComponent: KeysError,
  component: Keys,
});

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  name: {
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  // A long name or id ends in an ellipsis; its title holds all of it.
  truncate: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  id: {
    fontFamily: fonts.mono,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
  callout: { marginTop: space.s4 },
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

/**
 * The keys table's column widths (name, ID, added, last used, actions), fixed
 * like the accounts tables': the name takes what the rest leave, so a long one
 * ends in an ellipsis instead of pushing Last used and the row's actions off a
 * narrow screen, which drops ID and Added.
 */
const keyColumns = [
  "auto",
  { width: "22%", secondary: true },
  { width: "16%", secondary: true },
  "112px",
  actionsColumn,
] as const;

/** Focus the copy button as the new key comes in, as the submit button went with the form. */
const focusButton = (field: HTMLDivElement | null) => field?.querySelector("button")?.focus();

/**
 * Names a new key, then shows it the one time via ever returns it. It stays
 * mounted, so it animates out, and starts over once it has. Focus goes back to
 * the button that opened it, or to the page's heading when that button went
 * with the empty state the first key replaced.
 */
function CreateKeyDialog({
  open,
  onClose,
  opener,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly opener: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const heading = usePageHeading();
  const [name, setName] = useState("");
  const [missing, setMissing] = useState(false);

  const mutation = useMutation({
    mutationFn: () => createKey(name.trim()),
    onSuccess: (outcome) => {
      if (outcome.created) void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
    },
  });

  const created = mutation.data?.created === true ? mutation.data : undefined;
  const taken = mutation.data?.created === false ? mutation.data.duplicate : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      onOpenChangeComplete={(next) => {
        if (next) return;
        setName("");
        setMissing(false);
        mutation.reset();
      }}
    >
      <DialogContent
        size="lg"
        finalFocus={() => (opener.current?.isConnected === true ? opener.current : heading.current)}
      >
        {created === undefined ? (
          <form
            {...stylex.props(styles.form)}
            onSubmit={(event) => {
              event.preventDefault();

              if (name.trim() === "") return setMissing(true);
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
              error={
                missing
                  ? "Enter a name for the key."
                  : taken === undefined
                    ? undefined
                    : `A key named "${taken}" already exists. Choose another name.`
              }
            >
              <Input
                value={name}
                onValueChange={(value) => {
                  setName(value);
                  setMissing(false);
                  mutation.reset();
                }}
                name="name"
                autoComplete="off"
                spellCheck={false}
                placeholder="laptop, ci, cursor…"
              />
            </Field>
            {mutation.error !== null && (
              <div {...stylex.props(styles.callout)}>
                <Callout tone="danger" role="alert">
                  {mutation.error.message}
                </Callout>
              </div>
            )}
            <DialogFooter>
              <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
              <Button type="submit" loading={mutation.isPending}>
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
            <div ref={focusButton}>
              <CopyField label="API key" value={created.key} />
            </div>
            <div {...stylex.props(styles.callout)}>
              <Callout tone="warning">
                You won't see this key again. via stores only a hash of it; if you lose it, revoke
                it and create another.
              </Callout>
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

/** When a key was last used, "3 min ago", ticking; the full time on hover. */
function LastUsed({ at }: { readonly at: string | null }) {
  // A minute is the finest step "min ago" shows.
  const now = useNow(60_000);

  if (at === null) return "Never";

  return <Day at={at}>{timeAgo(at, now)}</Day>;
}

const title = "Keys";

const description = "The API keys clients use to call via. Each is shown once, when you create it.";

/** The page while the keys are on their way, which only a page without the shell's state waits for. */
function KeysLoading() {
  return (
    <Page title={title} description={description}>
      <Panel flush>
        <TableSkeleton rows={2} columns={keyColumns} label="Loading keys" />
      </Panel>
    </Page>
  );
}

function Keys() {
  const queryClient = useQueryClient();
  // While via pushes the state, the keys needn't be asked for.
  const keys = useSuspenseQuery({ ...keysQuery, ...useLiveOptions() });
  const [creating, setCreating] = useState(false);
  const opener = useRef<HTMLElement>(null);
  const dialogs = useRowDialog<Key, "rename" | "revoke">();
  const rename = dialogs.propsFor("rename");
  const revoke = dialogs.propsFor("revoke");
  const refetch = () => void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });

  const createButton = (
    <Button
      onClick={(event) => {
        opener.current = event.currentTarget;
        setCreating(true);
      }}
    >
      <PlusIcon size={15} />
      Create key
    </Button>
  );

  return (
    <Page
      title={title}
      description={description}
      actions={keys.data.length > 0 ? createButton : undefined}
    >
      {keys.data.length === 0 ? (
        <EmptyState
          icon={<KeyIcon size={18} />}
          title="No keys yet"
          description="Create a key for each client that talks to via, so you can revoke one without the others."
          action={createButton}
          headingLevel={2}
        />
      ) : (
        <Panel flush>
          <div {...stylex.props(styles.scroll)}>
            <Table aria-label="Keys" columns={keyColumns}>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead secondary>ID</TableHead>
                  <TableHead secondary>Added</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead actions />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.map((key, index) => (
                  <TableRow key={key.id} index={index}>
                    <TableCell>
                      <span title={key.name} {...stylex.props(styles.truncate, styles.name)}>
                        {key.name}
                      </span>
                    </TableCell>
                    <TableCell secondary>
                      <span title={key.id} {...stylex.props(styles.truncate, styles.id)}>
                        {key.id}
                      </span>
                    </TableCell>
                    <TableCell secondary>
                      <Day at={key.createdAt} />
                    </TableCell>
                    <TableCell>
                      <LastUsed at={key.lastUsedAt} />
                    </TableCell>
                    <TableCell actions>
                      <RowActions label={`Actions for ${key.name}`}>
                        <MenuItem
                          label="Rename…"
                          icon={<EditIcon size={15} />}
                          onClick={() => dialogs.show("rename", key)}
                        />
                        <MenuSeparator />
                        <MenuItem
                          label="Revoke…"
                          icon={<TrashIcon size={15} />}
                          destructive
                          onClick={() => dialogs.show("revoke", key)}
                        />
                      </RowActions>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
      )}

      <CreateKeyDialog open={creating} onClose={() => setCreating(false)} opener={opener} />
      {rename !== undefined && (
        <RenameDialog
          key={rename.row.id}
          {...rename}
          thing="Key"
          name={rename.row.name}
          field="Name"
          description="Clients keep using the same key; only its name changes."
          rename={(name) => renameKey(rename.row.id, name)}
          onRenamed={refetch}
        />
      )}
      {revoke !== undefined && (
        <ConfirmDialog
          key={revoke.row.id}
          {...revoke}
          title={`Revoke ${revoke.row.name}?`}
          description="Clients using it stop working at once. This can't be undone."
          confirmLabel="Revoke key"
          confirm={() => revokeKey(revoke.row.id)}
          onConfirmed={refetch}
          done={{
            title: "Key revoked",
            description: `Clients using ${revoke.row.name} are now refused (401 Unauthorized).`,
          }}
          failed={`Couldn't revoke ${revoke.row.name}`}
        />
      )}
    </Page>
  );
}

/** The page when its data couldn't be loaded: its header stays, and it can try again. */
function KeysError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Page title={title} description={description}>
      <QueryError
        what="keys"
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </Page>
  );
}
