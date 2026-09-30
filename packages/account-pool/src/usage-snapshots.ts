import { type Account, AccountStore } from "@via/codex-auth";
import type { UsageWindow } from "@via/pool";
import { type OpencodeGoAccount, OpencodeGoAccounts, Providers } from "@via/providers";
import type { OpenrouterBudget, ProviderUsage } from "@via/providers/schemas";
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { accountUsage } from "./account-pool.ts";

/** How old a snapshot gets before `latest` refreshes it, in the background. */
const MAX_AGE = Duration.minutes(1);

/** How many accounts a refresh asks ChatGPT, or OpenCode Go, about at once. */
const CONCURRENCY = 4;

/** What ChatGPT last said about an account's usage, or why it could not say, and when. */
export type AccountUsageSnapshot = {
  readonly account: Account;
  /** Epoch milliseconds. */
  readonly fetchedAt: number;
} & ({ readonly windows: ReadonlyArray<UsageWindow> } | { readonly error: string });

/** What OpenCode Go last said about an account's usage, or why it could not say, and when. */
export type OpencodeGoUsageSnapshot = {
  readonly account: OpencodeGoAccount;
  /** Epoch milliseconds. */
  readonly fetchedAt: number;
} & (
  | { readonly windows: Extract<ProviderUsage, { windows: unknown }>["windows"] }
  | { readonly error: string }
);

/** What OpenRouter last said of its key's budget, or why it could not say, and when. */
type OpenrouterBudgetSnapshot = {
  /** Epoch milliseconds. */
  readonly fetchedAt: number;
} & ({ readonly budget: OpenrouterBudget | null } | { readonly error: string });

/** The latest known usage of every ChatGPT and OpenCode Go account, and OpenRouter's budget. */
type UsageSnapshot = {
  readonly accounts: ReadonlyArray<AccountUsageSnapshot>;
  readonly opencodeGo: ReadonlyArray<OpencodeGoUsageSnapshot>;
  /** None while via has no OpenRouter key. */
  readonly openrouter: OpenrouterBudgetSnapshot | null;
};

const make = Effect.gen(function* () {
  const store = yield* AccountStore;
  const providers = yield* Providers;
  const opencodeGoStore = yield* OpencodeGoAccounts;
  // A refresh runs here, not in its caller: one caller giving up doesn't cut it
  // short for the others, and a background refresh outlives the request that started it.
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof accountUsage>>>();
  const stored = yield* Ref.make<UsageSnapshot>({ accounts: [], opencodeGo: [], openrouter: null });

  /** One account's usage, now; a failure, for whatever reason, is kept as why. */
  const fetchAccount = (account: Account) =>
    accountUsage(account).pipe(
      Effect.map((windows) => ({ windows })),
      Effect.catch((error) => Effect.succeed({ error: error.message })),
      Effect.flatMap((usage) =>
        Effect.map(Clock.currentTimeMillis, (fetchedAt) => ({ account, fetchedAt, ...usage })),
      ),
      Effect.provide(context),
    );

  /** One OpenCode Go account's usage, now, or why OpenCode Go could not say. */
  const fetchOpencodeGo = (account: OpencodeGoAccount) =>
    Effect.gen(function* () {
      const report = yield* providers.usage(account.apiKey);
      const fetchedAt = yield* Clock.currentTimeMillis;

      return "error" in report
        ? { account, fetchedAt, error: report.error }
        : { account, fetchedAt, windows: report.windows };
    });

  /** OpenRouter's budget, now, or why it could not say; none without a key. */
  const fetchOpenrouter = Effect.gen(function* () {
    const report = yield* providers.openrouter.budget;
    const fetchedAt = yield* Clock.currentTimeMillis;

    return Option.match(report, {
      onNone: () => null,
      onSome: (known): OpenrouterBudgetSnapshot => ({ fetchedAt, ...known }),
    });
  });

  const fetchAll = Effect.gen(function* () {
    const listed = yield* store.list;
    const listedGo = yield* opencodeGoStore.list;

    const [accounts, opencodeGo, openrouter] = yield* Effect.all(
      [
        Effect.forEach(listed, fetchAccount, { concurrency: CONCURRENCY }),
        Effect.forEach(listedGo, fetchOpencodeGo, { concurrency: CONCURRENCY }),
        fetchOpenrouter,
      ],
      { concurrency: "unbounded" },
    );

    const snapshot: UsageSnapshot = { accounts, opencodeGo, openrouter };

    yield* Ref.set(stored, snapshot);

    return snapshot;
  });

  // Changes when a refresh starts, and again once it has kept what it fetched.
  const running = yield* SubscriptionRef.make(
    Option.none<Deferred.Deferred<UsageSnapshot, Effect.Error<typeof fetchAll>>>(),
  );

  /** The refresh running now, or a new one when none is. */
  const start = SubscriptionRef.modifySomeEffect(running, (current) =>
    Option.match(current, {
      onSome: (done) => Effect.succeed([done, Option.none()] as const),
      onNone: () =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<UsageSnapshot, Effect.Error<typeof fetchAll>>();

          yield* fetchAll.pipe(
            Effect.onExit((exit) =>
              SubscriptionRef.set(running, Option.none()).pipe(
                Effect.andThen(Deferred.done(done, exit)),
              ),
            ),
            Effect.forkIn(scope),
          );

          return [done, Option.some(Option.some(done))] as const;
        }),
    }),
  );

  const refresh = Effect.flatMap(start, Deferred.await);

  const get = Ref.get(stored);

  const latest = Effect.gen(function* () {
    const listed = yield* store.list;
    const listedGo = yield* opencodeGoStore.list;
    const hasOpenrouter = Option.isSome(yield* providers.openrouter.get);
    const shown = current(listed, listedGo, hasOpenrouter, yield* get);
    const now = yield* Clock.currentTimeMillis;

    const oldest = Math.min(
      ...[
        ...shown.accounts,
        ...shown.opencodeGo,
        ...(shown.openrouter === null ? [] : [shown.openrouter]),
      ].map(({ fetchedAt }) => fetchedAt),
    );

    const missing =
      shown.accounts.length < listed.length ||
      shown.opencodeGo.length < listedGo.length ||
      (hasOpenrouter && shown.openrouter === null);

    if (missing || now - oldest >= Duration.toMillis(MAX_AGE)) {
      yield* start;
    }

    return { ...shown, refreshing: Option.isSome(yield* SubscriptionRef.get(running)) };
  });

  return {
    /**
     * Asks ChatGPT for every account's usage, a few at a time, and OpenCode Go
     * for each of its accounts', and keeps the answers. Joins a refresh already running
     * instead of starting another.
     */
    refresh,
    /** What is kept now, without waiting. */
    get,
    /**
     * What is kept, for the accounts there are now, without waiting: it starts a
     * refresh in the background when it has nothing yet for one of them or is a
     * minute old or more, and says whether one is running.
     */
    latest,
    /**
     * Signals now, then whenever what `latest` answers may have changed: when a
     * refresh starts, and once it has kept what it fetched.
     */
    changes: SubscriptionRef.changes(running).pipe(Stream.map(() => undefined)),
  };
});

/** `entries` for `listed`, in its order, with its labels. */
const kept = <A extends { readonly id: string }, E extends { readonly account: A }>(
  listed: ReadonlyArray<A>,
  entries: ReadonlyArray<E>,
): ReadonlyArray<E> => {
  const byId = new Map(entries.map((entry) => [entry.account.id, entry]));

  return listed.flatMap((account) => {
    const entry = byId.get(account.id);

    return entry === undefined ? [] : [{ ...entry, account }];
  });
};

/**
 * `snapshot`'s entries for the accounts `listed` and `listedGo`, in their order,
 * with their labels, and OpenRouter's budget while via has its key.
 */
const current = (
  listed: ReadonlyArray<Account>,
  listedGo: ReadonlyArray<OpencodeGoAccount>,
  hasOpenrouter: boolean,
  snapshot: UsageSnapshot,
): UsageSnapshot => ({
  accounts: kept(listed, snapshot.accounts),
  opencodeGo: kept(listedGo, snapshot.opencodeGo),
  openrouter: hasOpenrouter ? snapshot.openrouter : null,
});

/**
 * The latest usage every ChatGPT and OpenCode Go account reported, kept in memory so the
 * dashboard shows it at once. The usage poll refreshes it; `latest` does too,
 * in the background, when it is missing or a minute old.
 */
export class UsageSnapshots extends Context.Service<UsageSnapshots, Effect.Success<typeof make>>()(
  "via/UsageSnapshots",
) {
  static readonly layer = Layer.effect(UsageSnapshots, make);
}
