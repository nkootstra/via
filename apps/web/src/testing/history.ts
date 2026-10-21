/** Usage history answers for tests: a group's figures, and a breakdown of groups with their totals. */
import { Option } from "effect";
import type {
  ConversationSummary,
  HistoryBreakdown,
  HistoryGroup,
  LiveTurn,
  OpenAttempt,
  TurnAttempt,
  UsageRequest,
} from "../api/types.ts";

export const cost = (
  apiEquivalentUsd: number,
  billedUsd = 0,
  unpriced: ReadonlyArray<string> = [],
) => ({
  apiEquivalentUsd,
  billedUsd,
  unpriced,
});

export const group = (
  fields: Partial<HistoryGroup> & Pick<HistoryGroup, "group">,
): HistoryGroup => ({
  label: fields.group,
  requests: 10,
  errors: 0,
  fellBack: 0,
  measured: 10,
  unmeasured: 0,
  inputTokens: 1_000,
  cachedTokens: 400,
  outputTokens: 200,
  reasoningTokens: 0,
  firstChunkMs: { p50: Option.some(400), p95: Option.some(1_200) },
  cost: cost(0.5),
  ...fields,
});

export const breakdown = (groups: ReadonlyArray<HistoryGroup>): HistoryBreakdown => ({
  groups,
  totals: {
    requests: groups.reduce((sum, g) => sum + g.requests, 0),
    errors: groups.reduce((sum, g) => sum + g.errors, 0),
    fellBack: groups.reduce((sum, g) => sum + g.fellBack, 0),
    measured: groups.reduce((sum, g) => sum + g.measured, 0),
    unmeasured: groups.reduce((sum, g) => sum + g.unmeasured, 0),
    inputTokens: groups.reduce((sum, g) => sum + g.inputTokens, 0),
    cachedTokens: groups.reduce((sum, g) => sum + g.cachedTokens, 0),
    outputTokens: groups.reduce((sum, g) => sum + g.outputTokens, 0),
    reasoningTokens: 0,
    firstChunkMs: { p50: Option.some(400), p95: Option.some(1_200) },
    cost: cost(
      groups.reduce((sum, g) => sum + g.cost.apiEquivalentUsd, 0),
      groups.reduce((sum, g) => sum + g.cost.billedUsd, 0),
    ),
  },
});

/** A request the usage history kept: an hour before the usage tests' clock, with `fields` over the rest. */
export const request = (
  fields: Partial<UsageRequest> & Pick<UsageRequest, "requestId">,
): UsageRequest => ({
  at: Date.parse("2026-09-27T11:30:00.000Z"),
  status: 200,
  error: Option.none(),
  errorMessage: Option.none(),
  streamEnd: Option.some("completed"),
  keyId: Option.some("key-1"),
  keyName: Option.some("laptop"),
  model: "gpt-6-astra",
  provider: "codex",
  accountId: Option.some("acc-1"),
  accountLabel: Option.some("work@example.com"),
  inputTokens: Option.some(1_200),
  cachedTokens: Option.some(800),
  cacheWriteTokens: Option.none(),
  outputTokens: Option.some(300),
  reasoningTokens: Option.none(),
  costUsd: Option.none(),
  durationMs: 2_400,
  firstChunkMs: Option.some(600),
  requestedModel: Option.none(),
  fallbackReason: Option.none(),
  conversationId: Option.none(),
  parentConversationId: Option.none(),
  sessionSource: Option.none(),
  agentType: Option.none(),
  client: Option.none(),
  ...fields,
});

/** A conversation the usage history kept: OpenCode's, of the hour before the usage tests' clock. */
export const conversation = (
  fields: Partial<ConversationSummary> & Pick<ConversationSummary, "id">,
): ConversationSummary => ({
  source: "x-opencode-session-id",
  guessed: false,
  client: Option.some("opencode/1.19.3"),
  keyName: Option.some("laptop"),
  models: ["gpt-6-astra"],
  firstAt: Date.parse("2026-09-27T11:30:00.000Z"),
  lastAt: Date.parse("2026-09-27T11:45:00.000Z"),
  turns: 4,
  subagents: 0,
  inputTokens: 4_000,
  cachedTokens: 3_000,
  outputTokens: 800,
  reasoningTokens: 0,
  failed: 0,
  fellBack: 0,
  cost: cost(0.12),
  ...fields,
});

/** A turn in flight, as `/admin/events` sends it: OpenCode's, of the usage tests' clock. */
export const liveTurn = (fields: Partial<LiveTurn> & Pick<LiveTurn, "requestId">): LiveTurn => ({
  at: Date.parse("2026-09-27T12:29:55.000Z"),
  model: "gpt-6-astra",
  conversationId: Option.some("ses_1"),
  parentConversationId: Option.none(),
  agentType: Option.none(),
  client: Option.some("opencode/1.19.3"),
  keyName: Option.some("laptop"),
  attempts: [],
  ...fields,
});

/** An upstream attempt of a turn in flight, still under way. */
export const openAttempt = (
  fields: Partial<OpenAttempt> & Pick<OpenAttempt, "requestId">,
): OpenAttempt => ({
  state: "open",
  seq: 0,
  startedAt: Date.parse("2026-09-27T12:29:55.000Z"),
  provider: "codex",
  model: "gpt-6-astra",
  accountId: Option.none(),
  accountLabel: Option.none(),
  status: Option.none(),
  firstChunkMs: Option.none(),
  ...fields,
});

/** An upstream attempt of `requestId` that served, as the usage history keeps one. */
export const attempt = (
  fields: Partial<TurnAttempt> & Pick<TurnAttempt, "requestId">,
): TurnAttempt => ({
  seq: 0,
  startedAt: Date.parse("2026-09-27T11:30:00.000Z"),
  durationMs: 2_000,
  firstChunkMs: Option.none(),
  provider: "codex",
  model: "gpt-6-astra",
  accountId: Option.none(),
  accountLabel: Option.none(),
  status: Option.some(200),
  outcome: "served",
  category: Option.none(),
  upstreamCode: Option.none(),
  downstreamProvider: Option.none(),
  message: Option.none(),
  ...fields,
});
