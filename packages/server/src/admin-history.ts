import { AccountStore } from "@via/codex-auth";
import type { ModelPrice } from "@via/config";
import { KeyStore } from "@via/keys";
import { OpencodeGoAccounts } from "@via/providers";
import {
  costOf,
  type GroupBy,
  type GroupUsage,
  type Percentiles,
  type PriceBook,
  priceBook,
  UsageHistory,
} from "@via/usage";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AdminApi } from "./admin-api.ts";

/** The history is via's own database; failing to use it is a defect, which answers 500. */
const readHistory = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.orDie(effect);

/** Requests a page lists when the query doesn't say. */
const PAGE = 50;

/**
 * The names keys and accounts go by now, by id, so a renamed one shows its new
 * name. A group whose key or account is gone keeps the name it had.
 */
const currentNames = (groupBy: GroupBy) =>
  Effect.gen(function* () {
    if (groupBy === "key") {
      const keys = yield* Effect.flatMap(KeyStore, (store) => store.list);

      return new Map(keys.map((key) => [key.id, key.name]));
    }

    if (groupBy === "account") {
      const codex = yield* Effect.flatMap(AccountStore, (store) => store.list);
      const opencodeGo = yield* Effect.flatMap(OpencodeGoAccounts, (store) => store.list);

      return new Map([...codex, ...opencodeGo].map((account) => [account.id, account.label]));
    }

    return new Map<string, string>();
  }).pipe(
    // The stores are via's own files, read on every request it serves; failing to now is a defect.
    Effect.orDie,
  );

const sum = (groups: ReadonlyArray<GroupUsage>, field: keyof GroupUsage & keyof typeof zero) =>
  groups.reduce((total, group) => total + group[field], 0);

const zero = {
  requests: 0,
  errors: 0,
  measured: 0,
  unmeasured: 0,
  inputTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

/** The totals of `groups` and their cost, as the admin API answers them. */
const totals = (groups: ReadonlyArray<GroupUsage>, firstChunkMs: Percentiles, book: PriceBook) => ({
  requests: sum(groups, "requests"),
  errors: sum(groups, "errors"),
  measured: sum(groups, "measured"),
  unmeasured: sum(groups, "unmeasured"),
  inputTokens: sum(groups, "inputTokens"),
  cachedTokens: sum(groups, "cachedTokens"),
  outputTokens: sum(groups, "outputTokens"),
  reasoningTokens: sum(groups, "reasoningTokens"),
  firstChunkMs,
  cost: costOf(
    groups.flatMap((group) => group.models),
    book,
  ),
});

/** The usage history, priced with config.yaml's `prices` over the prices via ships with. */
export const history = (prices: Readonly<Record<string, ModelPrice>>) => {
  const book = priceBook(prices);

  return HttpApiBuilder.group(AdminApi, "history", (handlers) =>
    handlers
      .handle("series", ({ query }) =>
        Effect.flatMap(UsageHistory, (usage) => usage.series(query)).pipe(
          Effect.map((points) => ({ points })),
          readHistory,
        ),
      )
      .handle("breakdown", ({ query }) =>
        Effect.gen(function* () {
          const { groups, firstChunkMs } = yield* readHistory(
            Effect.flatMap(UsageHistory, (usage) => usage.breakdown(query)),
          );

          const names = yield* currentNames(query.groupBy);

          return {
            groups: groups.map((group) => ({
              group: group.group,
              label: names.get(group.group) ?? group.label,
              ...totals([group], group.firstChunkMs, book),
            })),
            totals: totals(groups, firstChunkMs, book),
          };
        }),
      )
      .handle("clear", () =>
        Effect.flatMap(UsageHistory, (usage) => usage.clear).pipe(
          Effect.map((deleted) => ({ deleted })),
          readHistory,
        ),
      )
      .handle("requests", ({ query }) =>
        Effect.flatMap(UsageHistory, (usage) =>
          usage.requests({
            from: query.from,
            to: query.to,
            limit: query.limit ?? PAGE,
            cursor:
              query.afterAt === undefined || query.afterId === undefined
                ? undefined
                : { at: query.afterAt, requestId: query.afterId },
            model: query.model,
            accountId: query.accountId,
            keyId: query.keyId,
            outcome: query.outcome,
          }),
        ).pipe(readHistory),
      ),
  );
};
