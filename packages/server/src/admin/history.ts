import { AccountStore } from "@via/codex-auth";
import type { ModelPrice } from "@via/config";
import { KeyStore } from "@via/keys";
import { OpencodeGoAccounts, Providers } from "@via/providers";
import {
  type ConversationUsage,
  costOf,
  type GroupBy,
  type GroupUsage,
  type Percentiles,
  type PriceBook,
  priceBook,
  CapturedRequests,
  CaptureSettingsStore,
  UsageHistory,
} from "@via/usage";
import { Effect, Option } from "effect";
import { adminCapture } from "./state.ts";
import { HttpApiBuilder } from "effect/http-api";
import { AdminApi, CapturedRequestNotFoundError, ConversationNotFoundError } from "./api.ts";

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
  fellBack: 0,
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
  fellBack: sum(groups, "fellBack"),
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

/** A conversation as the admin API answers it, priced with `book`. */
const conversationSummary = (conversation: ConversationUsage, book: PriceBook) => ({
  id: conversation.id,
  source: conversation.source,
  guessed: conversation.source === "hash",
  client: conversation.client,
  keyName: conversation.keyName,
  models: conversation.models.map((usage) => usage.model),
  firstAt: conversation.firstAt,
  lastAt: conversation.lastAt,
  turns: conversation.turns,
  subagents: conversation.subagents,
  inputTokens: conversation.inputTokens,
  cachedTokens: conversation.cachedTokens,
  outputTokens: conversation.outputTokens,
  reasoningTokens: conversation.reasoningTokens,
  failed: conversation.failed,
  fellBack: conversation.fellBack,
  cost: costOf(conversation.models, book),
});

/** A query's `fellBack`, as the history reads it. */
const fellBackOf = (query: { readonly fellBack?: "true" | "false" }) =>
  query.fellBack === undefined ? undefined : query.fellBack === "true";

/**
 * The usage history, priced with config.yaml's `prices` over the prices via
 * ships with, and a local provider's models at nothing.
 */
export const history = (prices: Readonly<Record<string, ModelPrice>>) =>
  HttpApiBuilder.group(AdminApi, "history", (handlers) =>
    handlers
      .handle("series", ({ query }) =>
        Effect.flatMap(UsageHistory, (usage) =>
          usage.series({ ...query, fellBack: fellBackOf(query) }),
        ).pipe(
          Effect.map((points) => ({ points })),
          readHistory,
        ),
      )
      .handle("breakdown", ({ query }) =>
        Effect.gen(function* () {
          const book = priceBook(prices, { local: yield* (yield* Providers).local });

          const { groups, firstChunkMs } = yield* readHistory(
            Effect.flatMap(UsageHistory, (usage) =>
              usage.breakdown({ ...query, fellBack: fellBackOf(query) }),
            ),
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
        Effect.gen(function* () {
          const captured = yield* CapturedRequests;
          // The captured bodies first: a turn they belong to is never gone while one stays.
          yield* captured.clear;
          const deleted = yield* (yield* UsageHistory).clear;
          // And again: a turn that settled meanwhile kept its capture before its history row,
          // which the history's delete took, so the capture would be left with no turn.
          yield* captured.clear;

          return { deleted };
        }).pipe(readHistory),
      )
      .handle("capturedRequest", ({ params }) =>
        Effect.gen(function* () {
          const found = yield* readHistory(
            Effect.flatMap(CapturedRequests, (captured) => captured.get(params.requestId)),
          );

          if (Option.isNone(found)) {
            return yield* new CapturedRequestNotFoundError({ requestId: params.requestId });
          }

          return found.value;
        }),
      )
      .handle("clearCaptured", () =>
        Effect.flatMap(CapturedRequests, (captured) => captured.clear).pipe(
          Effect.map((deleted) => ({ deleted })),
          readHistory,
        ),
      )
      .handle("captureSettings", () => adminCapture)
      .handle("setCaptureSettings", ({ payload }) =>
        Effect.flatMap(CaptureSettingsStore, (store) => store.set(payload)).pipe(
          Effect.as(payload),
          // The setting is via's own file; failing to write it is a defect, which answers 500.
          Effect.orDie,
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
            fellBack: fellBackOf(query),
          }),
        ).pipe(readHistory),
      )
      .handle("conversations", ({ query }) =>
        Effect.gen(function* () {
          const book = priceBook(prices, { local: yield* (yield* Providers).local });

          const page = yield* readHistory(
            Effect.flatMap(UsageHistory, (usage) =>
              usage.conversations({
                from: query.from,
                to: query.to,
                limit: query.limit ?? PAGE,
                cursor:
                  query.afterAt === undefined || query.afterId === undefined
                    ? undefined
                    : { at: query.afterAt, id: query.afterId },
                model: query.model,
                accountId: query.accountId,
                keyId: query.keyId,
                outcome: query.outcome,
                fellBack: fellBackOf(query),
              }),
            ),
          );

          return {
            conversations: page.conversations.map((found) => conversationSummary(found, book)),
            next: page.next,
          };
        }),
      )
      .handle("conversation", ({ params }) =>
        Effect.gen(function* () {
          const book = priceBook(prices, { local: yield* (yield* Providers).local });

          const found = yield* readHistory(
            Effect.flatMap(UsageHistory, (usage) => usage.conversation(params.id)),
          );

          if (Option.isNone(found)) return yield* new ConversationNotFoundError({ id: params.id });

          const captured = yield* readHistory(
            Effect.flatMap(CapturedRequests, (requests) =>
              requests.which(found.value.turns.map((turn) => turn.requestId)),
            ),
          );

          return {
            summary: conversationSummary(found.value.summary, book),
            turns: found.value.turns,
            attempts: found.value.attempts,
            captured,
          };
        }),
      ),
  );
