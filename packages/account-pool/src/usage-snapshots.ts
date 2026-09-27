import { type Account, AccountStore } from "@via/codex-auth";
import type { UsageWindow } from "@via/pool";
import { Providers } from "@via/providers";
import type { ProviderUsage } from "@via/providers/schemas";
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
  SynchronizedRef,
} from "effect";
import { accountUsage } from "./account-pool.ts";

/** How old a snapshot gets before `latest` refreshes it, in the background. */
const MAX_AGE = Duration.minutes(1);

/** How many accounts a refresh asks ChatGPT about at once. */
const CONCURRENCY = 4;

/** What ChatGPT last said about an account's usage, or why it could not say, and when. */
export type AccountUsageSnapshot = {
  readonly account: Account;
  /** Epoch milliseconds. */
  readonly fetchedAt: number;
} & ({ readonly windows: ReadonlyArray<UsageWindow> } | { readonly error: string });

/** The usage every provider last reported, and when. */
type ProvidersUsageSnapshot = {
  readonly reports: ReadonlyArray<ProviderUsage>;
  /** Epoch milliseconds. */
  readonly fetchedAt: number;
};

/** The latest known usage of every account and provider; `providers` is unset before the first refresh. */
type UsageSnapshot = {
  readonly accounts: ReadonlyArray<AccountUsageSnapshot>;
  readonly providers: ProvidersUsageSnapshot | undefined;
};

const make = Effect.gen(function* () {
  const store = yield* AccountStore;
  const providers = yield* Providers;
  // A refresh runs here, not in its caller: one caller giving up doesn't cut it
  // short for the others, and a background refresh outlives the request that started it.
  const scope = yield* Scope.Scope;
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof accountUsage>>>();
  const stored = yield* Ref.make<UsageSnapshot>({ accounts: [], providers: undefined });

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

  const fetchAll = Effect.gen(function* () {
    const listed = yield* store.list;

    const [accounts, reports] = yield* Effect.all(
      [Effect.forEach(listed, fetchAccount, { concurrency: CONCURRENCY }), providers.usage],
      { concurrency: "unbounded" },
    );

    const snapshot = {
      accounts,
      providers: { reports, fetchedAt: yield* Clock.currentTimeMillis },
    };

    yield* Ref.set(stored, snapshot);

    return snapshot;
  });

  const running = yield* SynchronizedRef.make(
    Option.none<Deferred.Deferred<UsageSnapshot, Effect.Error<typeof fetchAll>>>(),
  );

  /** The refresh running now, or a new one when none is. */
  const start = SynchronizedRef.modifyEffect(running, (current) =>
    Option.match(current, {
      onSome: (done) => Effect.succeed([done, current] as const),
      onNone: () =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<UsageSnapshot, Effect.Error<typeof fetchAll>>();

          yield* fetchAll.pipe(
            Effect.onExit((exit) =>
              SynchronizedRef.set(running, Option.none()).pipe(
                Effect.andThen(Deferred.done(done, exit)),
              ),
            ),
            Effect.forkIn(scope),
          );

          return [done, Option.some(done)] as const;
        }),
    }),
  );

  const refresh = Effect.flatMap(start, Deferred.await);

  const get = Ref.get(stored);

  const latest = Effect.gen(function* () {
    const listed = yield* store.list;
    const snapshot = yield* get;
    const byId = new Map(snapshot.accounts.map((entry) => [entry.account.id, entry]));

    if (snapshot.providers === undefined || listed.some(({ id }) => !byId.has(id))) {
      return current(listed, yield* refresh);
    }

    const shown = current(listed, snapshot);

    const oldest = Math.min(
      snapshot.providers.fetchedAt,
      ...shown.accounts.map(({ fetchedAt }) => fetchedAt),
    );

    if ((yield* Clock.currentTimeMillis) - oldest >= Duration.toMillis(MAX_AGE)) yield* start;

    return shown;
  });

  return {
    /**
     * Asks ChatGPT for every account's usage, a few at a time, and every provider
     * for its own, and keeps the answers. Joins a refresh already running
     * instead of starting another.
     */
    refresh,
    /** What is kept now, without waiting. */
    get,
    /**
     * What is kept, for the accounts there are now: after waiting for a refresh
     * when there is nothing yet for one of them, and starting one in the
     * background when it is a minute old or more.
     */
    latest,
  };
});

/** `snapshot`'s entries for `listed`, in its order, with its labels. */
const current = (listed: ReadonlyArray<Account>, snapshot: UsageSnapshot): UsageSnapshot => {
  const byId = new Map(snapshot.accounts.map((entry) => [entry.account.id, entry]));

  return {
    accounts: listed.flatMap((account) => {
      const entry = byId.get(account.id);

      return entry === undefined ? [] : [{ ...entry, account }];
    }),
    providers: snapshot.providers,
  };
};

/**
 * The latest usage every account and provider reported, kept in memory so the
 * dashboard shows it at once. The usage poll refreshes it; `latest` does too
 * when it is a minute old.
 */
export class UsageSnapshots extends Context.Service<UsageSnapshots, Effect.Success<typeof make>>()(
  "via/UsageSnapshots",
) {
  static readonly layer = Layer.effect(UsageSnapshots, make);
}
