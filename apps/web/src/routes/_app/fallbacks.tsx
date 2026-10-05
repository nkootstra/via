import * as stylex from "@stylexjs/stylex";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createFileRoute, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  EmptyState,
  MenuItem,
  MenuSeparator,
  RowActions,
  Skeleton,
  VisuallyHidden,
} from "@via/ui";
import { colors, fontWeights, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { fallbacksQuery, modelsQuery, refreshFallbacks, removeFallback } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import type { Availability, Fallback } from "../../api/types.ts";
import { BackIn } from "../../components/back-in.tsx";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { FallbackDialog } from "../../components/fallback-dialog.tsx";
import {
  ArrowRightIcon,
  EditIcon,
  FallbacksIcon,
  PlusIcon,
  TrashIcon,
} from "../../components/icons.tsx";
import { useRowDialog } from "../../components/row-dialog.ts";
import { modelEntries, withoutPrefix } from "../../lib/model-entries.ts";
import { ModelName } from "../../components/model-name.tsx";
import { Page, Panel } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";
import {
  announcement,
  sameStanding,
  skipped,
  type Standing,
  standingOf,
} from "../../lib/fallbacks.ts";
import { poolReason } from "../../lib/pool-reason.ts";
import { formatTime } from "../../lib/time.ts";
import { useTimeFormat } from "../../lib/time-format.ts";

export const Route = createFileRoute("/_app/fallbacks")({
  head: () => ({ meta: [{ title: "Fallbacks · via" }] }),
  // The models say which fallbacks via no longer lists, and what the dialog offers.
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(fallbacksQuery),
      queryClient.ensureQueryData(modelsQuery),
    ]),
  pendingComponent: FallbacksLoading,
  errorComponent: FallbacksError,
  component: Fallbacks,
});

const styles = stylex.create({
  // Rows share one panel, a hairline apart, so a chain can wrap on a phone.
  rows: {
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingBlock: space.s3,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  // The chain leads; the badge and actions keep to the end, or wrap under it on a phone.
  top: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space.s4,
    rowGap: space.s2,
  },
  side: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    marginInlineStart: "auto",
  },
  details: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  detail: {
    margin: 0,
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  failing: { color: colors.foreground },
  chain: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  source: {
    margin: 0,
    minWidth: 0,
    fontFamily: fonts.mono,
    fontSize: text.code,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  targets: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  target: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  arrow: {
    display: "flex",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    minWidth: 0,
    maxWidth: "100%",
    paddingBlock: space.s0_5,
    paddingInline: space.s2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.item,
    fontFamily: fonts.mono,
    fontSize: text.caption,
    color: colors.foreground,
  },
  // The model answering in its place: ringed in the badge's amber, not by colour alone.
  serving: {
    borderColor: colors.warning,
    boxShadow: `0 0 0 1px ${colors.warning}`,
    backgroundColor: colors.warningSubtle,
  },
  // A model via skips: drawn dashed and faded, with a note under the chain that says why.
  skipped: {
    borderStyle: "dashed",
    color: colors.mutedForeground,
  },
  now: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
});

const title = "Fallbacks";

const description =
  "When a model can't take a request, via sends it to the next model in its list, so clients get an answer instead of an error.";

/** The page's status region, for a screen reader alone. */
function Status({ children }: { readonly children: string }) {
  return (
    <VisuallyHidden>
      <output aria-live="polite">{children}</output>
    </VisuallyHidden>
  );
}

/** The page while the rules load: shaped like them, hidden from assistive tech, which hears the status. */
function FallbacksLoading() {
  return (
    <Page title={title} description={description}>
      <Status>Loading fallbacks…</Status>
      <Panel>
        <div aria-hidden="true" {...stylex.props(styles.rows)}>
          {[0, 1].map((index) => (
            <div key={index} {...stylex.props(styles.row)}>
              <div {...stylex.props(styles.chain)}>
                <Skeleton width="96px" height="16px" />
                <Skeleton width="80px" height="20px" />
                <Skeleton width="80px" height="20px" />
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </Page>
  );
}

/** The page when its data couldn't be loaded: its header stays, and it can try again. */
function FallbacksError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Page title={title} description={description}>
      <QueryError
        what="fallbacks"
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </Page>
  );
}

/** How a rule stands, as a badge in the Overview's colours. */
function StandingBadge({ standing }: { readonly standing: Standing }) {
  switch (standing.state) {
    case "standing-by":
      return (
        <Badge variant="dot" color="green">
          Standing by
        </Badge>
      );
    case "falling-back":
      return (
        <Badge variant="dot" color="amber">
          Falling back
        </Badge>
      );
    case "none":
      return (
        <Badge variant="dot" color="red">
          No fallback available
        </Badge>
      );
  }
}

/** Why a model can't answer now, and, while it cools down, until when. */
function WhyNot({ availability }: { readonly availability: Availability }) {
  const format = useTimeFormat();

  switch (availability.status) {
    case "available":
      return null;
    case "cooling":
      return (
        <p {...stylex.props(styles.detail)}>
          {poolReason(availability.reason)} · <BackIn until={availability.until} /> · Ends{" "}
          {formatTime(availability.until, format)}
        </p>
      );
    case "unavailable":
      return (
        <p {...stylex.props(styles.detail)}>
          {availability.reason === "no_accounts" ? "No account can serve it" : "Not enabled"}
        </p>
      );
  }
}

/** A rule: its model, then the models it falls back to, in order, and how it stands. */
function Rule({
  rule,
  listed,
  onEdit,
  onRemove,
}: {
  readonly rule: Fallback;
  /** Every model id via lists now. */
  readonly listed: ReadonlySet<string>;
  readonly onEdit: (opener: HTMLElement | null) => void;
  readonly onRemove: () => void;
}) {
  const actions = useRef<HTMLDivElement>(null);
  const standing = standingOf(rule);

  const notes = rule.fallbacks.flatMap(
    (target, index) => skipped(target, rule.status.fallbacks[index], listed) ?? [],
  );

  return (
    <article aria-label={rule.model} {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.top)}>
        <div {...stylex.props(styles.chain)}>
          <h2 {...stylex.props(styles.source)}>
            <ModelName id={rule.model} />
          </h2>
          <ol aria-label="Falls back to" {...stylex.props(styles.targets)}>
            {rule.fallbacks.map((target, index) => {
              const serving = standing.state === "falling-back" && standing.to === target;
              const skip = skipped(target, rule.status.fallbacks[index], listed) !== undefined;

              return (
                <li key={target} {...stylex.props(styles.target)}>
                  <span {...stylex.props(styles.arrow)}>
                    <ArrowRightIcon size={14} />
                  </span>
                  <span
                    aria-current={serving ? "true" : undefined}
                    {...stylex.props(
                      styles.chip,
                      serving && styles.serving,
                      skip && styles.skipped,
                    )}
                  >
                    <ModelName id={target} />
                  </span>
                  {serving && <span {...stylex.props(styles.now)}>answering now</span>}
                </li>
              );
            })}
          </ol>
        </div>
        <div ref={actions} {...stylex.props(styles.side)}>
          <StandingBadge standing={standing} />
          <RowActions label={`Actions for ${rule.model}`}>
            <MenuItem
              label="Edit…"
              icon={<EditIcon size={15} />}
              // Focus goes back to the row's menu button once the dialog closes.
              onClick={() => onEdit(actions.current?.querySelector("button") ?? null)}
            />
            <MenuSeparator />
            <MenuItem
              label="Remove…"
              icon={<TrashIcon size={15} />}
              destructive
              onClick={onRemove}
            />
          </RowActions>
        </div>
      </div>
      {(standing.state !== "standing-by" || notes.length > 0) && (
        <div {...stylex.props(styles.details)}>
          {standing.state === "none" && (
            <p {...stylex.props(styles.detail, styles.failing)}>
              Every model in the list is unavailable too, so requests fail.
            </p>
          )}
          {standing.state !== "standing-by" && <WhyNot availability={rule.status.source} />}
          {notes.map((note) => (
            <p key={note} {...stylex.props(styles.detail)}>
              {note}
            </p>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * What changed in how the rules stand since they last did, in words: a rule
 * that started or stopped falling back. A rule just added, or a countdown
 * ticking, is no news.
 */
function useTransitions(rules: ReadonlyArray<Fallback>) {
  const seen = useRef<ReadonlyMap<string, Standing> | null>(null);
  const [news, setNews] = useState("");

  useEffect(() => {
    const before = seen.current;
    const standings = new Map(rules.map((rule) => [rule.model, standingOf(rule)]));
    seen.current = standings;

    if (before === null) return;

    const changed = [...standings].flatMap(([model, standing]) => {
      const was = before.get(model);

      return was === undefined || sameStanding(was, standing)
        ? []
        : [announcement(model, standing)];
    });

    if (changed.length > 0) setNews(changed.join(" "));
  }, [rules]);

  return news;
}

function Fallbacks() {
  // While via pushes the state, the rules and how they stand needn't be asked for.
  const live = useLiveOptions();
  const fallbacks = useSuspenseQuery({ ...fallbacksQuery, ...live });
  const models = useSuspenseQuery({ ...modelsQuery, ...live });
  const listed = new Set(models.data.map((model) => model.id));
  const entries = modelEntries(models.data);
  const news = useTransitions(fallbacks.data);
  const queryClient = useQueryClient();
  const opener = useRef<HTMLElement | null>(null);

  // The add or edit dialog, while it shows: kept as it animates out, then gone, so it starts afresh.
  // Each opening counts, so one opened while the last is still on its way out starts afresh too.
  const [editing, setEditing] = useState<{
    readonly rule: Fallback | undefined;
    readonly open: boolean;
    readonly opening: number;
  } | null>(null);

  const dialogs = useRowDialog<Fallback, "remove">();
  const remove = dialogs.propsFor("remove");

  const edit = (rule: Fallback | undefined, from: HTMLElement | null) => {
    opener.current = from;
    setEditing((current) => ({ rule, open: true, opening: (current?.opening ?? 0) + 1 }));
  };

  const addButton = (
    <Button onClick={(event) => edit(undefined, event.currentTarget)}>
      <PlusIcon size={15} />
      Add fallback
    </Button>
  );

  return (
    <Page
      title={title}
      description={description}
      actions={fallbacks.data.length > 0 ? addButton : undefined}
    >
      {/* Rendered from the start, so a screen reader hears it as it changes. */}
      <Status>{news}</Status>
      {fallbacks.data.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={<FallbacksIcon size={18} />}
          title="No fallbacks yet"
          description="Add one, and when a model is cooling down or out of reach, via answers with another you choose instead of an error."
          action={addButton}
        />
      ) : (
        <Panel>
          <div {...stylex.props(styles.rows)}>
            {fallbacks.data.map((rule) => (
              <Rule
                key={rule.model}
                rule={rule}
                listed={listed}
                onEdit={(from) => edit(rule, from)}
                onRemove={() => dialogs.show("remove", rule)}
              />
            ))}
          </div>
        </Panel>
      )}
      {editing !== null && (
        <FallbackDialog
          key={editing.opening}
          open={editing.open}
          onClose={() => setEditing((current) => current && { ...current, open: false })}
          onClosed={() => setEditing(null)}
          rule={editing.rule}
          rules={fallbacks.data}
          entries={entries}
          opener={opener}
        />
      )}
      {remove !== undefined && (
        <ConfirmDialog
          key={remove.row.model}
          {...remove}
          title={`Remove the fallback for ${withoutPrefix(remove.row.model)}?`}
          description={`When ${withoutPrefix(remove.row.model)} can't answer, its requests fail again instead of going to ${withoutPrefix(remove.row.fallbacks[0] ?? "")}.`}
          confirmLabel="Remove fallback"
          confirm={() => removeFallback(remove.row.model)}
          onConfirmed={() => refreshFallbacks(queryClient)}
          done={{
            title: "Fallback removed",
            description: `Requests for ${withoutPrefix(remove.row.model)} no longer fall back.`,
          }}
          failed="Couldn't remove fallback"
        />
      )}
    </Page>
  );
}
