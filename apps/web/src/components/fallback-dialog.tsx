/**
 * Adds a fallback rule, or edits one's list: the model that falls back, then
 * the models it falls back to, in order. What via would refuse is said at the
 * field before it's sent; what via refuses anyway is said there too. The
 * dialog stays open until the rule is saved.
 */
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SearchSelect,
  useToast,
} from "@via/ui";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { type RefObject, useId, useRef, useState } from "react";
import { refreshFallbacks, saveFallback } from "../api/admin.ts";
import type { Fallback } from "../api/types.ts";
import { problemOf } from "../lib/fallbacks.ts";
import { type ModelEntry, withoutPrefix } from "../lib/model-entries.ts";
import { useMask } from "../lib/privacy.ts";
import { ChainEditor } from "./chain-editor.tsx";
import { ModelName } from "./model-name.tsx";
import { modelGroups } from "./model-picker.tsx";
import { usePageHeading } from "./page.tsx";

const styles = stylex.create({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    margin: 0,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space.s1_5,
    minWidth: 0,
  },
  // The list takes the dialog's width; the pickers keep their own.
  wide: { alignItems: "stretch" },
  label: {
    fontSize: text.body,
    color: colors.mutedForeground,
  },
  error: {
    margin: 0,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.destructive,
  },
  // In edit mode the model is fixed: shown, not offered.
  fixed: {
    display: "inline-flex",
    maxWidth: "100%",
    paddingBlock: space.s1_5,
    paddingInline: space.s2_5,
    borderRadius: radii.item,
    backgroundColor: colors.muted,
    fontFamily: fonts.mono,
    fontSize: text.code,
    color: colors.foreground,
  },
  picked: {
    fontFamily: fonts.mono,
    fontSize: text.code,
  },
});

/** A message as a sentence: via's own end without a full stop. */
const sentence = (message: string) => (/[.!?]$/.test(message) ? message : `${message}.`);

/** The first combobox in `scope`: a picker's trigger, to take focus. */
const pickerIn = (scope: HTMLElement | null) =>
  scope?.querySelector<HTMLElement>("[role='combobox']") ?? scope?.querySelector("button");

export function FallbackDialog({
  open,
  onClose,
  onClosed,
  rule,
  rules,
  entries,
  opener,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Once it has animated out, when it can go. */
  readonly onClosed: () => void;
  /** The rule to edit; none to add one. */
  readonly rule: Fallback | undefined;
  /** Every rule, so a model that has one can't get another. */
  readonly rules: ReadonlyArray<Fallback>;
  readonly entries: ReadonlyArray<ModelEntry>;
  /** The button that opened it, for focus to go back to. */
  readonly opener: RefObject<HTMLElement | null>;
}) {
  const toast = useToast();
  const mask = useMask();
  const queryClient = useQueryClient();
  const heading = usePageHeading();
  const ids = { source: useId(), sourceError: useId(), chain: useId(), chainError: useId() };
  const sourceField = useRef<HTMLDivElement>(null);
  const chainField = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(rule?.model ?? null);
  const [chain, setChain] = useState<ReadonlyArray<string>>(rule?.fallbacks ?? []);
  const [sourceError, setSourceError] = useState<string>();
  const [chainError, setChainError] = useState<string>();
  const editing = rule !== undefined;

  const mutation = useMutation({
    mutationFn: (saved: { readonly model: string; readonly fallbacks: ReadonlyArray<string> }) =>
      saveFallback(saved.model, saved.fallbacks),
    onSuccess: (outcome, saved) => {
      if (!outcome.saved) {
        setChainError(sentence(outcome.problem));
        pickerIn(chainField.current)?.focus();

        return;
      }

      refreshFallbacks(queryClient);
      toast.add(
        editing
          ? {
              title: "Fallback saved",
              description: `${withoutPrefix(saved.model)}'s list is updated.`,
            }
          : {
              title: "Fallback added",
              description: `When ${withoutPrefix(saved.model)} can't answer, ${
                saved.fallbacks.length === 1
                  ? `via sends its requests to ${withoutPrefix(saved.fallbacks[0] ?? "")}`
                  : `via tries ${saved.fallbacks.map(withoutPrefix).join(", then ")}`
              }.`,
            },
      );
      onClose();
    },
    onError: (error) =>
      toast.add({
        type: "error",
        title: "Couldn't save fallback",
        description: mask.key(error.message),
      }),
  });

  const taken = new Set(rules.map((existing) => existing.model));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && !mutation.isPending && onClose()}
      onOpenChangeComplete={(next) => !next && onClosed()}
    >
      <DialogContent
        size="lg"
        finalFocus={() => (opener.current?.isConnected === true ? opener.current : heading.current)}
      >
        <form
          noValidate
          {...stylex.props(styles.form)}
          onSubmit={(event) => {
            event.preventDefault();

            if (source === null) {
              setSourceError("Choose a model to fall back from.");
              pickerIn(sourceField.current)?.focus();

              return;
            }

            const problem = problemOf(source, chain);

            if (problem !== undefined) {
              setChainError(sentence(problem));
              pickerIn(chainField.current)?.focus();

              return;
            }

            mutation.mutate({ model: source, fallbacks: chain });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit the fallback for ${withoutPrefix(rule.model)}` : "Add a fallback"}
            </DialogTitle>
            <DialogDescription>
              When the model can't take a request, via tries these in order and answers with the
              first that can.
            </DialogDescription>
          </DialogHeader>

          <div ref={sourceField} {...stylex.props(styles.field)}>
            <span id={ids.source} {...stylex.props(styles.label)}>
              Fall back from
            </span>
            {editing ? (
              <span aria-labelledby={ids.source} {...stylex.props(styles.fixed)}>
                <ModelName id={rule.model} wrap />
              </span>
            ) : (
              <SearchSelect
                label="Fall back from"
                groups={modelGroups(entries, {
                  unavailable: (id) => (taken.has(id) ? "Has a fallback" : undefined),
                })}
                value={source}
                onValueChange={(value) => {
                  setSource(value);
                  setSourceError(undefined);
                  // A model can't fall back to itself.
                  setChain((current) => current.filter((id) => id !== value));
                }}
                trigger={
                  source === null ? (
                    "Choose a model"
                  ) : (
                    <span {...stylex.props(styles.picked)}>
                      <ModelName id={source} />
                    </span>
                  )
                }
                placeholder="Search models"
                emptyText="No model matches"
                error={sourceError === undefined ? undefined : ids.sourceError}
              />
            )}
            {sourceError !== undefined && (
              <p id={ids.sourceError} {...stylex.props(styles.error)}>
                {sourceError}
              </p>
            )}
          </div>

          <div ref={chainField} {...stylex.props(styles.field, styles.wide)}>
            <span id={ids.chain} {...stylex.props(styles.label)}>
              Fall back to, in order
            </span>
            <ChainEditor
              source={source}
              chain={chain}
              onChange={(next) => {
                setChain(next);
                setChainError(undefined);
              }}
              entries={entries}
              labelledBy={ids.chain}
              error={chainError === undefined ? undefined : ids.chainError}
            />
            {chainError !== undefined && (
              <p id={ids.chainError} {...stylex.props(styles.error)}>
                {chainError}
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose
              disabled={mutation.isPending}
              render={<Button variant="tertiary">Cancel</Button>}
            />
            <Button type="submit" loading={mutation.isPending}>
              {editing ? "Save fallback" : "Add fallback"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
