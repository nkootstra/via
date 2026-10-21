/** The usage page's Conversations tab: one row per conversation, the latest active first. */
import * as stylex from "@stylexjs/stylex";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from "@via/ui";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Option } from "effect";
import { historyConversationsQuery, type HistoryFilters, type HistorySpan } from "../api/admin.ts";
import { useSignalledOptions } from "../api/live.ts";
import { useEndedTurns, useLiveTurns } from "../api/turns.ts";
import type { ConversationSummary } from "../api/types.ts";
import { harnessName } from "../lib/harness.ts";
import { unlisted } from "../lib/live-conversations.ts";
import { useMask } from "../lib/privacy.ts";
import { ago, formatMoment, useNow } from "../lib/time.ts";
import { useTimeFormat } from "../lib/time-format.ts";
import { formatCount, formatTokens, tokensOf } from "../lib/usage-format.ts";
import { changed } from "../lib/usage-search.ts";
import { CostAmount } from "./cost.tsx";
import { GuessedBadge } from "./guessed-badge.tsx";
import { UsageIcon } from "./icons.tsx";
import { ModelName } from "./model-name.tsx";
import { Panel } from "./page.tsx";
import { QueryError } from "./query-error.tsx";

const styles = stylex.create({
  scroll: { overflowX: "auto" },
  // Every row keeps a badge's height and never wraps, so a "Live" badge coming
  // and going doesn't shift the rows: the name gives way with an ellipsis.
  title: {
    display: "flex",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    minHeight: "24px",
  },
  badge: { flexShrink: 0 },
  // The harness's name opens the conversation: reads as the name, acts as a link.
  open: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "3px",
    outlineOffset: "2px",
    borderRadius: radii.item,
  },
  under: {
    display: "block",
    marginTop: space.s0_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  models: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    minWidth: 0,
    fontFamily: fonts.mono,
    fontSize: text.caption,
  },
  more: {
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  number: {
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  // A turn count's notes wrap between words, never inside one.
  tally: { overflowWrap: "normal" },
  failed: { color: colors.destructive },
  loadMore: {
    display: "flex",
    justifyContent: "center",
    padding: space.s3,
  },
});

/**
 * The list's columns: the conversation (its harness over its time), key,
 * models, turns, tokens and cost. A phone keeps the conversation, turns and
 * cost: the last two as wide as "1 sub-agent" and a cost need, at any width.
 */
const columns = [
  "auto",
  { width: "13%", secondary: true },
  { width: "18%", secondary: true },
  "6.75rem",
  { width: "11%", secondary: true },
  "5.25rem",
] as const;

const plural = (count: number, one: string, many: string) =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

export function ConversationList({
  span,
  filters,
  rangeLabel,
  filtered,
  onClear,
}: {
  readonly span: HistorySpan;
  readonly filters: HistoryFilters;
  /** The range, as "the last …" reads it: "day", "week". */
  readonly rangeLabel: string;
  /** Whether the filters narrow the page, so an empty list offers to clear them. */
  readonly filtered: boolean;
  readonly onClear: () => void;
}) {
  const conversations = useInfiniteQuery({
    ...historyConversationsQuery(span, filters),
    ...useSignalledOptions(),
  });

  const ended = useEndedTurns();
  const inFlight = useLiveTurns();

  if (conversations.isError) {
    return (
      <QueryError
        what="conversations"
        error={conversations.error}
        onRetry={() => void conversations.refetch()}
      />
    );
  }

  if (conversations.data === undefined) {
    return <TableSkeleton rows={3} columns={columns} label="Loading conversations" />;
  }

  const listed = conversations.data.pages.flatMap((page) => page.conversations);
  const { live, pending } = unlisted(new Set(listed.map(({ id }) => id)), ended, inFlight);
  // A conversation the history doesn't have yet leads the list; a filtered list can't say
  // whether it matches until then.
  const rows = [...(filtered ? [] : pending), ...listed];

  if (rows.length === 0) {
    return filtered ? (
      <EmptyState
        icon={<UsageIcon size={18} />}
        title="No conversations match these filters"
        description={`None in the last ${rangeLabel}. Try a longer range, or clear the filters.`}
        action={
          <Button variant="secondary" onClick={onClear}>
            Clear filters
          </Button>
        }
        headingLevel={2}
      />
    ) : (
      <EmptyState
        icon={<UsageIcon size={18} />}
        title={`No conversations in the last ${rangeLabel}`}
        description="Coding agents' requests show up here grouped by the session or thread they belong to, with their sub-agents'."
        headingLevel={2}
      />
    );
  }

  return (
    <Panel flush>
      <div {...stylex.props(styles.scroll)}>
        <Table aria-label="Conversations" columns={columns}>
          <TableHeader>
            <TableRow>
              <TableHead>Conversation</TableHead>
              <TableHead secondary>Key</TableHead>
              <TableHead secondary>Models</TableHead>
              <TableHead>Turns</TableHead>
              <TableHead secondary>Tokens</TableHead>
              <TableHead>Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((conversation, index) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                live={live.has(conversation.id)}
                index={index}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {conversations.hasNextPage && (
        <div {...stylex.props(styles.loadMore)}>
          <Button
            variant="secondary"
            loading={conversations.isFetchingNextPage}
            onClick={() => void conversations.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      )}
    </Panel>
  );
}

function ConversationRow({
  conversation,
  live,
  index,
}: {
  readonly conversation: ConversationSummary;
  /** Whether a turn of it, or of a sub-agent of it, is in flight. */
  readonly live: boolean;
  readonly index: number;
}) {
  const mask = useMask();
  const format = useTimeFormat();
  const now = useNow(60_000);
  const [model, ...others] = conversation.models;

  const trouble = [
    ...(conversation.failed > 0 ? [`${formatCount(conversation.failed)} failed`] : []),
    ...(conversation.fellBack > 0 ? [`${formatCount(conversation.fellBack)} fell back`] : []),
  ];

  return (
    <TableRow index={index}>
      <TableCell>
        <span {...stylex.props(styles.title)}>
          <Link
            to="/usage"
            search={(current) => changed(current, { conversation: conversation.id })}
            title={conversation.id}
            {...stylex.props(styles.open)}
          >
            {harnessName(conversation.client, conversation.source)}
          </Link>
          {conversation.guessed && (
            <span {...stylex.props(styles.badge)}>
              <GuessedBadge />
            </span>
          )}
          {live && (
            <span {...stylex.props(styles.badge)}>
              <Badge color="green" variant="dot" title="A turn of it is in flight now">
                Live
              </Badge>
            </span>
          )}
        </span>
        <span
          title={`${formatMoment(conversation.firstAt, format)} – ${formatMoment(conversation.lastAt, format)}`}
          {...stylex.props(styles.under)}
        >
          {ago(now - conversation.firstAt)} → {ago(now - conversation.lastAt)}
        </span>
      </TableCell>
      <TableCell secondary>{mask.key(Option.getOrElse(conversation.keyName, () => "–"))}</TableCell>
      <TableCell secondary>
        {model === undefined ? (
          "–"
        ) : (
          <span title={conversation.models.join(", ")} {...stylex.props(styles.models)}>
            <ModelName id={model} />
            {others.length > 0 && <span {...stylex.props(styles.more)}>+{others.length}</span>}
          </span>
        )}
      </TableCell>
      <TableCell>
        <span {...stylex.props(styles.number)}>{formatCount(conversation.turns)}</span>
        {conversation.subagents > 0 && (
          <span {...stylex.props(styles.under, styles.tally)}>
            {plural(conversation.subagents, "sub-agent", "sub-agents")}
          </span>
        )}
        {trouble.length > 0 && (
          <span
            {...stylex.props(styles.under, styles.tally, conversation.failed > 0 && styles.failed)}
          >
            {trouble.join(" · ")}
          </span>
        )}
      </TableCell>
      <TableCell secondary>
        <span {...stylex.props(styles.number)}>{formatTokens(tokensOf(conversation))}</span>
      </TableCell>
      <TableCell>
        <CostAmount cost={conversation.cost} />
      </TableCell>
    </TableRow>
  );
}
