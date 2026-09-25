import { type Account, AccountStore, AccountTokens } from "@via/codex-auth";
import { available, PoolStates, select } from "@via/pool";
import { Array, Clock, Effect, Option } from "effect";

/**
 * The account with an access token fresh enough to send; none when refreshing
 * fails. A dead refresh token locks the account out; an auth-server hiccup
 * cools it down for a minute.
 */
const withFreshToken = (account: Account) =>
  Effect.gen(function* () {
    const tokens = yield* AccountTokens;
    const states = yield* PoolStates;
    const now = yield* Clock.currentTimeMillis;
    return yield* tokens.fresh(account).pipe(
      Effect.asSome,
      Effect.catchTags({
        RefreshRejectedError: (error) =>
          Effect.logWarning(
            `${account.label} is locked out until it logs in again (${error.code})`,
          ).pipe(
            Effect.andThen(states.lockOut(account.id, error.code)),
            Effect.as(Option.none<Account>()),
          ),
        AuthRequestError: () =>
          Effect.logWarning(
            `${account.label} is cooling down until ${new Date(now + 60_000).toISOString()} (auth_unavailable)`,
          ).pipe(
            Effect.andThen(
              states.mark(account.id, {
                status: "cooling",
                until: now + 60_000,
                reason: "auth_unavailable",
              }),
            ),
            Effect.as(Option.none<Account>()),
          ),
      }),
    );
  });

/** The accounts `allowed` lets serve a request, in the order they were added. */
export const accountsAllowed = (allowed: (accountId: string) => boolean) =>
  Effect.gen(function* () {
    const accounts = yield* (yield* AccountStore).list;
    return accounts.filter((account) => allowed(account.id));
  });

/**
 * The account among those `allowed` the pool would use next, with a fresh
 * access token: `preferred` if it names one that is available, else
 * fill-first, skipping accounts cooling down or locked out. None once no
 * account can be used.
 */
export const nextAccount = (
  allowed: (accountId: string) => boolean,
  preferred: Option.Option<string> = Option.none(),
) =>
  Effect.gen(function* () {
    const states = yield* PoolStates;
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const chosen = select(yield* accountsAllowed(allowed), yield* states.get, now, preferred);
      if (Option.isNone(chosen)) return Option.none<Account>();
      const fresh = yield* withFreshToken(chosen.value);
      if (Option.isSome(fresh)) return fresh;
    }
  });

/** Every account the pool could use now, each with a fresh access token. */
export const usableAccounts = Effect.gen(function* () {
  const store = yield* AccountStore;
  const states = yield* PoolStates;
  const now = yield* Clock.currentTimeMillis;
  const accounts = available(yield* store.list, yield* states.get, now);
  return Array.getSomes(
    yield* Effect.forEach(accounts, withFreshToken, { concurrency: "unbounded" }),
  );
});
