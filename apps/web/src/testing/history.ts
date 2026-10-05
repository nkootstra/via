/** Usage history answers for tests: a group's figures, and a breakdown of groups with their totals. */
import { Option } from "effect";
import type { HistoryBreakdown, HistoryGroup, UsageRequest } from "../api/types.ts";

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
  ...fields,
});
