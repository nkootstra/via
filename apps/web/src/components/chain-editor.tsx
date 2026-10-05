/**
 * The models a model falls back to, in order: each can move up or down or go,
 * and Add model puts another at the end, up to via's limit. Keyboard first,
 * no dragging: focus follows a model as it moves, and goes on to the next
 * when one goes. Every change is said aloud.
 */
import * as stylex from "@stylexjs/stylex";
import { Button, SearchSelect, VisuallyHidden } from "@via/ui";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { effortHint, MAX_FALLBACKS } from "../lib/fallbacks.ts";
import { type ModelEntry, withoutPrefix } from "../lib/model-entries.ts";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, PlusIcon } from "./icons.tsx";
import { ModelName } from "./model-name.tsx";
import { modelGroups } from "./model-picker.tsx";

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "20px minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space.s2,
    rowGap: space.s0_5,
    paddingBlock: space.s1,
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s1,
    borderRadius: radii.item,
    backgroundColor: colors.muted,
  },
  position: {
    fontSize: text.caption,
    fontVariantNumeric: "tabular-nums",
    color: colors.mutedForeground,
  },
  name: {
    minWidth: 0,
    fontFamily: fonts.mono,
    fontSize: text.code,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  actions: {
    display: "flex",
    alignItems: "center",
  },
  // Under the name, in its column: what a request with an effort gets.
  hint: {
    gridColumn: "2 / -1",
    margin: 0,
    paddingBlockEnd: space.s1,
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.mutedForeground,
  },
  foot: {
    display: "flex",
    alignItems: "center",
    marginTop: space.s2,
  },
  full: {
    margin: 0,
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
});

type Move = "up" | "down" | "remove";

/** Where focus goes once the list has changed: a model's button, or Add model. */
type Focus =
  | {
      readonly model: string;
      readonly action: Move;
      /** Whether to wait out the dialog's own move, after the focused picker went. */
      readonly settle?: boolean;
    }
  | { readonly model: null; readonly settle?: undefined };

export function ChainEditor({
  source,
  chain,
  onChange,
  entries,
  labelledBy,
  error,
}: {
  /** The model that falls back, which can't be its own fallback. */
  readonly source: string | null;
  readonly chain: ReadonlyArray<string>;
  readonly onChange: (chain: ReadonlyArray<string>) => void;
  readonly entries: ReadonlyArray<ModelEntry>;
  /** The id of the list's visible label. */
  readonly labelledBy: string;
  /** The id of the error the form shows for the list, while it shows one. */
  readonly error: string | undefined;
}) {
  const list = useRef<HTMLOListElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const focus = useRef<Focus | null>(null);
  const [said, setSaid] = useState("");

  // Once the list has changed and rendered, focus goes where the change asked for.
  useEffect(() => {
    const next = focus.current;
    focus.current = null;

    if (next === null) return;

    const target =
      next.model === null
        ? foot.current?.querySelector<HTMLElement>("[role='combobox']")
        : list.current?.querySelector<HTMLElement>(
            `[data-model="${CSS.escape(next.model)}"] [data-action="${next.action}"]`,
          );

    target?.focus();

    if (!next.settle) return;

    // The picker that had focus closed and went: once the dialog has looked for
    // somewhere to put focus instead, it goes to the model just added.
    requestAnimationFrame(() => target?.isConnected === true && target.focus());
  });

  const move = (index: number, by: -1 | 1) => {
    const model = chain[index];
    const to = index + by;

    if (model === undefined || to < 0 || to >= chain.length) return;

    const next = chain.toSpliced(index, 1).toSpliced(to, 0, model);

    // At the end it went to, it can't go further that way: focus takes the way back.
    const action: Move =
      by < 0 ? (to === 0 ? "down" : "up") : to === chain.length - 1 ? "up" : "down";

    focus.current = { model, action };
    setSaid(
      `Moved ${withoutPrefix(model)} ${by < 0 ? "up" : "down"}, to ${to + 1} of ${chain.length}.`,
    );
    onChange(next);
  };

  const remove = (index: number) => {
    const model = chain[index];

    if (model === undefined) return;

    const next = chain.toSpliced(index, 1);
    const then = next[index] ?? next[index - 1];

    focus.current = then === undefined ? { model: null } : { model: then, action: "remove" };
    setSaid(`Removed ${withoutPrefix(model)}.`);
    onChange(next);
  };

  const add = (model: string) => {
    // The list is full now and Add model goes, so focus goes to the model just added.
    if (chain.length + 1 >= MAX_FALLBACKS) {
      focus.current = { model, action: "remove", settle: true };
    }

    setSaid(`Added ${withoutPrefix(model)}, ${chain.length + 1} of ${chain.length + 1}.`);
    onChange([...chain, model]);
  };

  const exclude = new Set([...chain, ...(source === null ? [] : [source])]);

  return (
    <>
      <VisuallyHidden>
        <output aria-live="polite">{said}</output>
      </VisuallyHidden>
      <ol
        ref={list}
        aria-labelledby={labelledBy}
        aria-describedby={error}
        {...stylex.props(styles.list)}
      >
        {chain.map((model, index) => {
          const name = withoutPrefix(model);
          const hint = source === null ? undefined : effortHint(source, model, entries);

          return (
            // Moves glide into place; under reduced motion, they land at once.
            <motion.li
              key={model}
              layout="position"
              transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              data-model={model}
              {...stylex.props(styles.row)}
            >
              <span aria-hidden="true" {...stylex.props(styles.position)}>
                {index + 1}
              </span>
              <span {...stylex.props(styles.name)}>
                <ModelName id={model} wrap />
              </span>
              <span {...stylex.props(styles.actions)}>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={`Move ${name} up`}
                  data-action="up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={`Move ${name} down`}
                  data-action="down"
                  disabled={index === chain.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={`Remove ${name}`}
                  data-action="remove"
                  onClick={() => remove(index)}
                >
                  <CloseIcon size={15} />
                </Button>
              </span>
              {hint !== undefined && <p {...stylex.props(styles.hint)}>{hint}</p>}
            </motion.li>
          );
        })}
      </ol>
      <div ref={foot} {...stylex.props(styles.foot)}>
        {chain.length < MAX_FALLBACKS ? (
          <SearchSelect
            label="Add model"
            groups={modelGroups(entries, { exclude })}
            value={null}
            onValueChange={add}
            trigger={
              <>
                <PlusIcon size={14} />
                Add model
              </>
            }
            placeholder="Search models"
            emptyText="No model matches"
            error={error}
          />
        ) : (
          <p {...stylex.props(styles.full)}>
            That's the most: a model falls back to at most {MAX_FALLBACKS} others.
          </p>
        )}
      </div>
    </>
  );
}
