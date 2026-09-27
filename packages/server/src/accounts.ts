import { type Account, AccountStore, AccountTokens } from "@via/codex-auth";
import { available, PoolStates, select } from "@via/pool";
import { Array, Clock, Effect, Option } from "effect";

/**
 * Takes `account` out of rotation until `until` (epoch milliseconds), with a
 * warning that says why, unless it already is for at least that long or is
 * locked out. Says whether it did.
 */
export const coolDown = (account: Account, until: number, reason: string) =>
  Effect.gen(function* () {
    const cooled = yield* (yield* PoolStates).coolDown(account.id, until, reason);

    if (cooled) {
      yield* Effect.logWarning(
        `${account.label} is cooling down until ${new Date(until).toISOString()} (${reason})`,
      );
    }

    return cooled;
  });

/** Takes `account` out of rotation until it logs in again, with a warning that says why. */
export const lockOut = (account: Account, reason: string) =>
  Effect.gen(function* () {
    yield* (yield* PoolStates).lockOut(account.id, reason);
    yield* Effect.logWarning(`${account.label} is locked out until it logs in again (${reason})`);
  });

/** How long an auth-server hiccup keeps an account out of rotation. */
const AUTH_HICCUP_MS = 60_000;

/**
 * Runs a refresh of `account`'s token, none when it fails: a dead refresh token
 * locks the account out; an auth-server hiccup cools it down for a minute.
 */
export const setAsideOnFailedRefresh =
  (account: Account) => (refresh: ReturnType<AccountTokens["Service"]["fresh"]>) =>
    refresh.pipe(
      Effect.asSome,
      Effect.catchTags({
        RefreshRejectedError: (error) =>
          Effect.as(lockOut(account, error.code), Option.none<Account>()),
        AuthRequestError: () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => coolDown(account, now + AUTH_HICCUP_MS, "auth_unavailable")),
            Effect.as(Option.none<Account>()),
          ),
      }),
    );

/** The account with an access token fresh enough to send; none when refreshing fails. */
const withFreshToken = (account: Account) =>
  Effect.flatMap(AccountTokens, (tokens) =>
    tokens.fresh(account).pipe(setAsideOnFailedRefresh(account)),
  );

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
  preferred: Option.Option<string>,
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
