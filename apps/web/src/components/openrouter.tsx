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
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useToast,
} from "@via/ui";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { useState } from "react";
import {
  openrouterCatalogQuery,
  openrouterQuery,
  refreshOpenrouter,
  removeOpenrouter,
  saveOpenrouterKey,
  saveOpenrouterModels,
} from "../api/admin.ts";
import { useLiveOptions } from "../api/live.ts";
import type { Openrouter, OpenrouterModel } from "../api/types.ts";
import { formatTokens } from "../lib/usage-format.ts";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { EditIcon, KeyIcon, PlusIcon, ProviderLogo, TrashIcon } from "./icons.tsx";
import { Panel } from "./page.tsx";
import { type RowDialogProps, useRowDialog } from "./row-dialog.ts";

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0,
  },
  key: {
    fontFamily: fonts.mono,
    whiteSpace: "nowrap",
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  caption: {
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
  },
  picker: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // Tall enough to scan a page of models; the dialog stays on screen on a phone.
  list: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    maxHeight: "min(50vh, 420px)",
    overflowY: "auto",
    borderRadius: radii.item,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  model: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderBottomWidth: { default: 1, ":last-child": 0 },
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  toggle: {
    marginInlineStart: "auto",
  },
  modelName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.body,
    color: colors.foreground,
  },
  count: {
    fontSize: text.caption,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  none: {
    margin: 0,
    padding: space.s3,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
});

/** The key, the models it enables, and the row's actions. */
const columns = ["auto", "42%", actionsColumn] as const;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** What a model costs and reads, as a line: "$2.00 in · $10.00 out per 1M · 400K context". */
const detailOf = ({ inputPerMillion, outputPerMillion, contextLength }: OpenrouterModel) => {
  const parts = [
    inputPerMillion === null || outputPerMillion === null
      ? "Price unknown"
      : `${usd.format(inputPerMillion)} in · ${usd.format(outputPerMillion)} out per 1M`,
    ...(contextLength === null ? [] : [`${formatTokens(contextLength)} context`]),
  ];

  return parts.join(" · ");
};

/** How many models a saved key enables, in words. */
const enabledText = ({ models, fromConfig }: Openrouter) => {
  if (fromConfig) return "Every model";

  if (models.length === 0) return "No models enabled yet";

  return models.length === 1 ? "1 model enabled" : `${models.length} models enabled`;
};

/** Asks for an OpenRouter key, which via checks with OpenRouter before it keeps it. */
function KeyDialog({ open, onClose, onClosed, row: current }: RowDialogProps<Openrouter | null>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [apiKey, setApiKey] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const key = apiKey.trim();

  const mutation = useMutation({
    mutationFn: () => saveOpenrouterKey(key),
    onSuccess: (refused) => {
      if (refused !== undefined) return setProblem(refused);

      refreshOpenrouter(queryClient);
      toast.add({
        title: current === null ? "OpenRouter key added" : "OpenRouter key replaced",
        description:
          current === null || current.models.length === 0
            ? "Choose the models via offers from its menu."
            : "Its models stay enabled.",
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

            if (key === "") return setProblem("Paste an OpenRouter API key.");
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {current === null ? "Add an OpenRouter key" : "Replace the OpenRouter key"}
            </DialogTitle>
            <DialogDescription>
              via checks the key with OpenRouter, then keeps it only on this machine. Create one at
              openrouter.ai under Keys.
            </DialogDescription>
          </DialogHeader>
          <Field label="API key" error={problem ?? mutation.error?.message}>
            <Input
              value={apiKey}
              onValueChange={(next) => {
                setApiKey(next);
                setProblem(undefined);
                mutation.reset();
              }}
              name="apiKey"
              type="password"
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

/** One model to enable or not: its name, what it costs, and a switch. */
function ModelChoice({
  model,
  enabled,
  onToggle,
}: {
  readonly model: OpenrouterModel;
  readonly enabled: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li {...stylex.props(styles.model)}>
      <span {...stylex.props(styles.stack)}>
        <span title={model.id} {...stylex.props(styles.modelName)}>
          {model.name}
        </span>
        <span {...stylex.props(styles.caption)}>{detailOf(model)}</span>
      </span>
      <span {...stylex.props(styles.toggle)}>
        <Switch aria-label={model.name} checked={enabled} onCheckedChange={onToggle} />
      </span>
    </li>
  );
}

/** Picks which of OpenRouter's models via offers, from all it lists, found by searching. */
function ModelsDialog({ open, onClose, onClosed, row: current }: RowDialogProps<Openrouter>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const catalog = useQuery(openrouterCatalogQuery);
  const [chosen, setChosen] = useState<ReadonlyArray<string>>(current.models);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();

  const mutation = useMutation({
    mutationFn: () => saveOpenrouterModels(chosen),
    onSuccess: () => {
      refreshOpenrouter(queryClient);
      toast.add({
        title: "OpenRouter models saved",
        description: `via offers ${chosen.length === 1 ? "1 model" : `${chosen.length} models`} of OpenRouter's.`,
      });
      onClose();
    },
  });

  const toggle = (id: string) =>
    setChosen((now) => (now.includes(id) ? now.filter((one) => one !== id) : [...now, id]));

  const shown = (catalog.data ?? []).filter(
    (model) =>
      needle === "" ||
      model.id.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle),
  );

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
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Choose OpenRouter models</DialogTitle>
            <DialogDescription>
              via lists only these in /v1/models, and refuses the rest. Prices are OpenRouter's.
            </DialogDescription>
          </DialogHeader>
          <div {...stylex.props(styles.picker)}>
            <Input
              value={search}
              onValueChange={setSearch}
              type="search"
              aria-label="Search models"
              placeholder="Search models"
              autoComplete="off"
              spellCheck={false}
            />
            <span {...stylex.props(styles.count)}>{chosen.length} enabled</span>
            {catalog.isPending ? (
              <output aria-label="Loading OpenRouter's models">
                <Skeleton height="160px" />
              </output>
            ) : catalog.isError ? (
              <p {...stylex.props(styles.none)}>
                OpenRouter's models couldn't be loaded: {catalog.error.message}
              </p>
            ) : (
              <ul aria-label="OpenRouter models" {...stylex.props(styles.list)}>
                {shown.length === 0 && <li {...stylex.props(styles.none)}>No models match.</li>}
                {shown.map((model) => (
                  <ModelChoice
                    key={model.id}
                    model={model}
                    enabled={chosen.includes(model.id)}
                    onToggle={() => toggle(model.id)}
                  />
                ))}
              </ul>
            )}
          </div>
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
 * OpenRouter, with the key the web UI saved: the key by its last four
 * characters and how many models it enables, with adding, replacing and
 * removing the key and choosing its models. One config.yaml sets up is only
 * shown, with every model, as config.yaml is where it changes.
 */
export function OpenrouterSection() {
  const queryClient = useQueryClient();
  const openrouter = useSuspenseQuery({ ...openrouterQuery, ...useLiveOptions() });
  const dialogs = useRowDialog<Openrouter | null, "key" | "models" | "remove">();
  const keyDialog = dialogs.propsFor("key");
  const modelsDialog = dialogs.propsFor("models");
  const remove = dialogs.propsFor("remove");
  const saved = openrouter.data;

  const body =
    saved === null ? (
      <EmptyState
        icon={<ProviderLogo name="openrouter" size={18} />}
        compact
        title="No OpenRouter key yet"
        description="Add an OpenRouter API key, then choose which of its models via offers."
        action={
          <Button variant="secondary" size="compact" onClick={() => dialogs.show("key", null)}>
            <PlusIcon size={14} />
            Add OpenRouter key
          </Button>
        }
      />
    ) : (
      <Panel flush>
        <div {...stylex.props(styles.scroll)}>
          <Table aria-label="OpenRouter" columns={columns}>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Models</TableHead>
                <TableHead actions />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow index={0}>
                <TableCell>
                  <div {...stylex.props(styles.stack)}>
                    <span {...stylex.props(styles.key)}>{saved.key}</span>
                    {saved.fromConfig && (
                      <span {...stylex.props(styles.caption)}>Set in config.yaml</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <span {...stylex.props(styles.caption)}>{enabledText(saved)}</span>
                </TableCell>
                <TableCell actions>
                  {!saved.fromConfig && (
                    <RowActions label="Actions for OpenRouter">
                      <MenuItem
                        label="Choose models…"
                        icon={<EditIcon size={15} />}
                        onClick={() => dialogs.show("models", saved)}
                      />
                      <MenuItem
                        label="Replace key…"
                        icon={<KeyIcon size={15} />}
                        onClick={() => dialogs.show("key", saved)}
                      />
                      <MenuSeparator />
                      <MenuItem
                        label="Remove…"
                        icon={<TrashIcon size={15} />}
                        destructive
                        onClick={() => dialogs.show("remove", saved)}
                      />
                    </RowActions>
                  )}
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
      {keyDialog !== undefined && <KeyDialog {...keyDialog} />}
      {modelsDialog !== undefined && modelsDialog.row !== null && (
        <ModelsDialog {...modelsDialog} row={modelsDialog.row} />
      )}
      {remove !== undefined && (
        <ConfirmDialog
          {...remove}
          title="Remove OpenRouter?"
          description="via forgets the key and stops offering OpenRouter's models. The key still works at OpenRouter."
          confirmLabel="Remove OpenRouter"
          confirm={removeOpenrouter}
          onConfirmed={() => refreshOpenrouter(queryClient)}
          done={{ title: "OpenRouter removed", description: "via no longer offers its models." }}
          failed="Couldn't remove OpenRouter"
        />
      )}
    </>
  );
}
