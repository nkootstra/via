/**
 * One conversation, open on the usage page's Conversations tab: what it came
 * from and what it cost, its turns on a waterfall, and its turns as a table.
 * A failed turn whose request via kept opens it in a sheet, from either.
 */
import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ConversationNotFoundError } from "@via/server/admin-api";
import {
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@via/ui";
import { Stat, StatList } from "@via/ui/chart";
import { colors, fonts, radii, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Option, Schema } from "effect";
import { useReducedMotionConfig } from "motion/react";
import { useState } from "react";
import { historyConversationQuery } from "../api/admin.ts";
import { useSignalledOptions } from "../api/live.ts";
import { useEndedTurns, useLiveTurns } from "../api/turns.ts";
import type { ConversationSummary, UsageRequest } from "../api/types.ts";
import { harnessName } from "../lib/harness.ts";
import { pendingSummary, type Standing, standing } from "../lib/live-conversations.ts";
import { withoutPrefix } from "../lib/model-entries.ts";
import { useMask } from "../lib/privacy.ts";
import { providerName } from "../lib/provider-name.ts";
import { failed, outcomeDetail, outcomeOf } from "../lib/request-outcome.ts";
import { formatMoment, useNow } from "../lib/time.ts";
import { useTimeFormat } from "../lib/time-format.ts";
import { timelineOf } from "../lib/timeline.ts";
import {
  formatCount,
  formatDuration,
  formatMs,
  formatShare,
  formatTokens,
  formatUsd,
  tokensOf,
} from "../lib/usage-format.ts";
import { changed } from "../lib/usage-search.ts";
import { GuessedBadge } from "./guessed-badge.tsx";
import { DocumentIcon, UsageIcon } from "./icons.tsx";
import { ModelName } from "./model-name.tsx";
import { Panel, Section } from "./page.tsx";
import { QueryError } from "./query-error.tsx";
import { RequestSheet, type ViewedTurn } from "./request-sheet.tsx";
import { Waterfall } from "./waterfall.tsx";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s6,
    minWidth: 0,
  },
  back: {
    alignSelf: "flex-start",
    fontSize: text.body,
    color: colors.mutedForeground,
    textDecorationLine: { default: "none", ":hover": "underline" },
    textUnderlineOffset: "3px",
    borderRadius: radii.item,
    outlineOffset: "2px",
  },
  header: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    minWidth: 0,
  },
  title: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    margin: 0,
    fontSize: text.title,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  id: {
    margin: 0,
    fontFamily: fonts.mono,
    fontSize: text.caption,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  scroll: { overflowX: "auto" },
  name: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: text.caption,
    color: colors.foreground,
  },
  under: {
    display: "block",
    marginTop: space.s0_5,
    fontSize: text.caption,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  number: {
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  outcome: {
    display: "block",
    overflowWrap: "anywhere",
    color: colors.foreground,
  },
  failed: { color: colors.destructive },
  view: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    height: "24px",
    marginTop: space.s1,
    paddingInline: space.s1_5,
    marginInlineStart: `calc(-1 * ${space.s1_5})`,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    fontFamily: "inherit",
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.focusRing}` },
  },
  cause: {
    display: "-webkit-box",
    marginTop: space.s0_5,
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflowWrap: "anywhere",
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
});

const isNotFound = Schema.is(ConversationNotFoundError);

/** Back to the list, the page's tab, range and filters as they were. */
function BackLink() {
  return (
    <Link
      to="/usage"
      search={(current) => changed(current, { conversation: undefined })}
      {...stylex.props(styles.back)}
    >
      <span aria-hidden="true">← </span>
      All conversations
    </Link>
  );
}

const nothingKept = { turns: [], attempts: [] };

const noneCaptured: ReadonlySet<string> = new Set();

export function ConversationDetail({ id }: { readonly id: string }) {
  const conversation = useQuery({ ...historyConversationQuery(id), ...useSignalledOptions() });
  const ended = useEndedTurns();
  const live = useLiveTurns();
  const now = standing(id, conversation.data ?? nothingKept, ended, live);
  const pending = now.turns.length > 0 || now.live.length > 0;

  return (
    <div {...stylex.props(styles.root)}>
      <BackLink />
      {conversation.data !== undefined ? (
        <Opened
          summary={conversation.data.summary}
          standing={now}
          captured={new Set(conversation.data.captured)}
        />
      ) : // A conversation whose first turn is in flight, or just ended: the history has none of it yet.
      pending && isNotFound(conversation.error) ? (
        <Opened
          summary={pendingSummary(id, now.turns, now.live)}
          standing={now}
          captured={noneCaptured}
        />
      ) : conversation.isError ? (
        isNotFound(conversation.error) ? (
          <EmptyState
            icon={<UsageIcon size={18} />}
            title="Conversation not found"
            description={conversation.error.message}
            headingLevel={2}
          />
        ) : (
          <QueryError
            what="the conversation"
            error={conversation.error}
            onRetry={() => void conversation.refetch()}
          />
        )
      ) : (
        <Skeleton height="240px" />
      )}
    </div>
  );
}

/**
 * How often the clock ticks while a turn is in flight, so its bar grows: often
 * enough to glide, or once a second for a viewer who asks for less motion.
 * With none in flight, nothing grows, and once a minute is plenty.
 */
const TICK_MS = { gliding: 100, still: 1_000, idle: 60_000 } as const;

function Opened({
  summary,
  standing: { turns, attempts, live },
  captured,
}: {
  readonly summary: ConversationSummary;
  readonly standing: Standing;
  /** The turns, by request id, whose request via kept. */
  readonly captured: ReadonlySet<string>;
}) {
  const format = useTimeFormat();
  const mask = useMask();
  const still = useReducedMotionConfig() === true;
  const now = useNow(live.length === 0 ? TICK_MS.idle : still ? TICK_MS.still : TICK_MS.gliding);
  // The turn whose request the sheet shows; it stays while the sheet closes, so it closes whole.
  const [viewing, setViewing] = useState<ViewedTurn | undefined>(undefined);
  const [sheetOpen, setSheetOpen] = useState(false);

  const view = (requestId: string, number: number) => {
    setViewing({
      requestId,
      number,
      attempts: attempts.filter((attempt) => attempt.requestId === requestId),
    });
    setSheetOpen(true);
  };

  const costDetail =
    summary.cost.unpriced.length > 0
      ? `Leaves out ${summary.cost.unpriced.join(", ")}: no price known`
      : summary.cost.billedUsd > 0
        ? `Plus ${formatUsd(summary.cost.billedUsd)} billed`
        : "At API prices";

  const trouble = [
    ...(summary.failed > 0 ? [`${formatCount(summary.failed)} failed`] : []),
    ...(summary.fellBack > 0 ? [`${formatCount(summary.fellBack)} fell back`] : []),
  ];

  return (
    <>
      <div {...stylex.props(styles.header)}>
        <h2 {...stylex.props(styles.title)}>
          {harnessName(summary.client, summary.source)}
          {summary.guessed && <GuessedBadge />}
        </h2>
        <p {...stylex.props(styles.id)}>
          {summary.id}
          {Option.match(summary.keyName, {
            onNone: () => "",
            onSome: (key) => ` · ${mask.key(key)}`,
          })}
          {` · ${formatMoment(summary.firstAt, format)}`}
        </p>
      </div>
      <StatList>
        <Stat
          label="Turns"
          value={formatCount(summary.turns)}
          detail={
            [
              ...(summary.subagents > 0
                ? [
                    `${formatCount(summary.subagents)} ${summary.subagents === 1 ? "sub-agent" : "sub-agents"}`,
                  ]
                : []),
              ...trouble,
              ...(live.length > 0 ? [`${formatCount(live.length)} in flight`] : []),
            ].join(" · ") || undefined
          }
        />
        <Stat
          label="Tokens"
          value={formatTokens(tokensOf(summary))}
          detail={`${formatTokens(summary.inputTokens)} in · ${formatTokens(summary.outputTokens)} out`}
        />
        <Stat
          label="Cache hit rate"
          value={formatShare(summary.cachedTokens, summary.inputTokens)}
          detail="of input tokens"
        />
        <Stat
          label="API-equivalent cost"
          value={formatUsd(summary.cost.apiEquivalentUsd)}
          detail={costDetail}
        />
        <Stat
          label="Lasted"
          value={formatDuration(summary.lastAt - summary.firstAt)}
          detail={`Last turn ${formatMoment(summary.lastAt, format)}`}
        />
      </StatList>
      <Section title="Timeline">
        <Panel>
          <Waterfall
            timeline={timelineOf(summary.id, turns, { attempts, live, now })}
            captured={captured}
            onViewRequest={view}
          />
        </Panel>
      </Section>
      {turns.length > 0 && (
        <Section title="Turns">
          <Turns rootId={summary.id} turns={turns} captured={captured} onView={view} />
        </Section>
      )}
      {viewing !== undefined && (
        <RequestSheet
          turn={viewing}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          onClosed={() => setViewing(undefined)}
        />
      )}
    </>
  );
}

/**
 * The turns table's columns: the turn (its model over its time and agent),
 * served by, tokens, duration and outcome. A phone keeps the turn, tokens and outcome.
 */
const columns = [
  "auto",
  { width: "20%", secondary: true },
  "14%",
  { width: "14%", secondary: true },
  "24%",
] as const;

/** Whose turn it was: the sub-agent's type, a plain sub-agent's, or none for the conversation's own. */
const agentOf = (turn: UsageRequest, rootId: string) =>
  Option.isSome(turn.agentType)
    ? Option.some(turn.agentType.value)
    : Option.contains(turn.conversationId, rootId) || Option.isNone(turn.conversationId)
      ? Option.none()
      : Option.some("Sub-agent");

function Turns({
  rootId,
  turns,
  captured,
  onView,
}: {
  readonly rootId: string;
  readonly turns: ReadonlyArray<UsageRequest>;
  readonly captured: ReadonlySet<string>;
  readonly onView: (requestId: string, number: number) => void;
}) {
  const mask = useMask();
  const format = useTimeFormat();

  return (
    <Panel flush>
      <div {...stylex.props(styles.scroll)}>
        <Table aria-label="Turns" columns={columns}>
          <TableHeader>
            <TableRow>
              <TableHead>Turn</TableHead>
              <TableHead secondary>Served by</TableHead>
              <TableHead>Tokens</TableHead>
              <TableHead secondary>Duration</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {turns.map((turn, index) => (
              <TableRow key={turn.requestId} index={index}>
                <TableCell>
                  <span {...stylex.props(styles.name)}>
                    <ModelName id={turn.model} />
                  </span>
                  {Option.isSome(turn.requestedModel) && (
                    <span title={turn.requestedModel.value} {...stylex.props(styles.under)}>
                      <span aria-hidden="true">↳ </span>
                      Fell back from {withoutPrefix(turn.requestedModel.value)}
                    </span>
                  )}
                  <span {...stylex.props(styles.under)}>
                    Turn {index + 1} · {formatMoment(turn.at, format)}
                    {Option.match(agentOf(turn, rootId), {
                      onNone: () => "",
                      onSome: (agent) => ` · ${agent}`,
                    })}
                  </span>
                </TableCell>
                <TableCell secondary>
                  {mask.key(Option.getOrElse(turn.accountLabel, () => providerName(turn.provider)))}
                </TableCell>
                <TableCell>
                  <span {...stylex.props(styles.number)}>
                    {Option.match(turn.inputTokens, {
                      onNone: () => "–",
                      onSome: (input) =>
                        formatTokens(input + Option.getOrElse(turn.outputTokens, () => 0)),
                    })}
                  </span>
                </TableCell>
                <TableCell secondary>
                  <span {...stylex.props(styles.number)}>{formatMs(turn.durationMs)}</span>
                  {Option.isSome(turn.firstChunkMs) && (
                    <span {...stylex.props(styles.under, styles.number)}>
                      First token {formatMs(turn.firstChunkMs.value)}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span
                    title={outcomeDetail(turn)}
                    {...stylex.props(styles.outcome, failed(turn) && styles.failed)}
                  >
                    {outcomeOf(turn)}
                  </span>
                  {Option.isSome(turn.errorMessage) && (
                    <span title={mask.key(turn.errorMessage.value)} {...stylex.props(styles.cause)}>
                      {mask.key(turn.errorMessage.value)}
                    </span>
                  )}
                  {captured.has(turn.requestId) && (
                    <button
                      type="button"
                      onClick={() => onView(turn.requestId, index + 1)}
                      {...stylex.props(styles.view)}
                    >
                      <DocumentIcon size={13} />
                      View request
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}
