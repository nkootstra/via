import * as stylex from "@stylexjs/stylex";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  actionsColumn,
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
  MenuItem,
  MenuSeparator,
  RowActions,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from "@via/ui";
import { colors, fonts, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { useState } from "react";
import {
  ollamaCheckQuery,
  ollamaQuery,
  refreshOllama,
  removeOllama,
  saveOllama,
} from "../api/admin.ts";
import { useLiveOptions } from "../api/live.ts";
import type { Ollama } from "../api/types.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { EditIcon, PlusIcon, ProviderLogo, TrashIcon } from "./icons.tsx";
import { Panel } from "./page.tsx";
import { type RowDialogProps, useRowDialog } from "./row-dialog.ts";
import { useMask } from "../lib/privacy.ts";

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0,
  },
  address: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  caption: {
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  version: {
    color: colors.foreground,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: text.code,
  },
  loading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
});

/** The address, what via found there, and the row's actions. */
const columns = ["auto", "42%", actionsColumn] as const;

/** Where Ollama listens on the machine via runs on, unless told otherwise. */
const USUAL_ADDRESS = "http://localhost:11434";

/** What via finds at Ollama's address, checked as it shows: its version and models, or why not. */
function OllamaStatus({ address }: { readonly address: string }) {
  const found = useQuery(ollamaCheckQuery(address));
  const mask = useMask();

  if (found.isPending) {
    return (
      <output aria-label="Checking Ollama" {...stylex.props(styles.loading)}>
        <Skeleton width="50%" height="12px" />
        <Skeleton width="80%" height="10px" />
      </output>
    );
  }

  if (found.isError) {
    return (
      <span {...stylex.props(styles.caption)}>
        Can't reach it: {mask.address(found.error.message)}
      </span>
    );
  }

  if (!found.data.reachable) {
    return (
      <span {...stylex.props(styles.caption)}>Can't reach it: {mask.text(found.data.reason)}</span>
    );
  }

  const { version, models } = found.data;

  return (
    <div {...stylex.props(styles.stack)}>
      <span {...stylex.props(styles.caption, styles.version)}>Ollama {version}</span>
      <span {...stylex.props(styles.caption)}>
        {models.length === 0 ? "No models yet: pull one with ollama pull" : models.join(", ")}
      </span>
    </div>
  );
}

/**
 * Asks for Ollama's address, to add it or, with `current`, to change it. Why via
 * refused an address shows in the form, which stays open to try again.
 */
function AddressDialog({ open, onClose, onClosed, row: current }: RowDialogProps<Ollama | null>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mask = useMask();
  const [value, setValue] = useState(current?.address ?? USUAL_ADDRESS);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const address = value.trim();

  const mutation = useMutation({
    mutationFn: () => saveOllama(address),
    onSuccess: (refused) => {
      if (refused !== undefined) return setProblem(refused);

      refreshOllama(queryClient);
      toast.add({
        title: current === null ? "Ollama added" : "Ollama's address changed",
        description: `via sends ollama/… models to ${mask.address(address)}.`,
      });
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      onOpenChangeComplete={(next) => !next && onClosed()}
    >
      <DialogContent>
        <form
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();

            if (address === "") return setProblem("Enter Ollama's address.");

            if (address === current?.address) return onClose();
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{current === null ? "Add Ollama" : "Change Ollama's address"}</DialogTitle>
            <DialogDescription>
              Where Ollama listens, such as{" "}
              <span {...stylex.props(styles.code)}>http://192.168.1.20:11434</span>. When via runs
              in Docker and Ollama on the same machine, it's{" "}
              <span {...stylex.props(styles.code)}>http://host.docker.internal:11434</span>.
            </DialogDescription>
          </DialogHeader>
          <Field label="Address" error={problem ?? mutation.error?.message}>
            <Input
              value={value}
              onValueChange={(next) => {
                setValue(next);
                setProblem(undefined);
                mutation.reset();
              }}
              name="address"
              type={mask.on ? "password" : "url"}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="tertiary">Cancel</Button>} />
            <Button type="submit" loading={mutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Ollama via sends `ollama/…` models to: where it is and what via finds
 * there, with adding, changing and removing it. One config.yaml sets up is only
 * shown, as config.yaml is where it changes.
 */
export function OllamaSection() {
  const queryClient = useQueryClient();
  const ollama = useSuspenseQuery({ ...ollamaQuery, ...useLiveOptions() });
  const mask = useMask();
  const dialogs = useRowDialog<Ollama | null, "address" | "remove">();
  const address = dialogs.propsFor("address");
  const remove = dialogs.propsFor("remove");
  const saved = ollama.data;

  const body =
    saved === null ? (
      <EmptyState
        icon={<ProviderLogo name="ollama" size={18} />}
        compact
        title="No Ollama yet"
        description="Give the address Ollama runs at, and via sends ollama/… models to it. Local models cost nothing."
        action={
          <Button variant="secondary" size="compact" onClick={() => dialogs.show("address", null)}>
            <PlusIcon size={14} />
            Add Ollama
          </Button>
        }
      />
    ) : (
      <Panel flush>
        <div {...stylex.props(styles.scroll)}>
          <Table aria-label="Ollama" columns={columns}>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Status</TableHead>
                <TableHead actions />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow index={0}>
                <TableCell>
                  <div {...stylex.props(styles.stack)}>
                    <span title={mask.address(saved.address)} {...stylex.props(styles.address)}>
                      {mask.address(saved.address)}
                    </span>
                    {saved.fromConfig && (
                      <span {...stylex.props(styles.caption)}>Set in config.yaml</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <OllamaStatus address={saved.address} />
                </TableCell>
                <TableCell actions>
                  <RowActions label="Actions for Ollama">
                    <MenuItem
                      label="Check again"
                      onClick={() =>
                        void queryClient.refetchQueries({
                          queryKey: ollamaCheckQuery(saved.address).queryKey,
                        })
                      }
                    />
                    {!saved.fromConfig && (
                      <>
                        <MenuItem
                          label="Change address…"
                          icon={<EditIcon size={15} />}
                          onClick={() => dialogs.show("address", saved)}
                        />
                        <MenuSeparator />
                        <MenuItem
                          label="Remove…"
                          icon={<TrashIcon size={15} />}
                          destructive
                          onClick={() => dialogs.show("remove", saved)}
                        />
                      </>
                    )}
                  </RowActions>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </Panel>
    );

  return (
    <>
      {body}
      {address !== undefined && <AddressDialog key={address.row?.address ?? "new"} {...address} />}
      {remove !== undefined && (
        <ConfirmDialog
          {...remove}
          title="Remove Ollama?"
          description="via stops sending ollama/… models to it. Ollama and its models stay as they are."
          confirmLabel="Remove Ollama"
          confirm={removeOllama}
          onConfirmed={() => refreshOllama(queryClient)}
          done={{ title: "Ollama removed", description: "via no longer sends models to it." }}
          failed="Couldn't remove Ollama"
        />
      )}
    </>
  );
}
