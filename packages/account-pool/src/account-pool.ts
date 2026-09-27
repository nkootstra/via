import { type Account, AccountStore, AccountTokens } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { pollable, PoolStates, retryAfter, select } from "@via/pool";
import { Clock, Context, Effect, Layer, Option } from "effect";

/** How long an auth-server hiccup keeps an account out of rotation. */
const AUTH_HICCUP_MS = 60_000;

const make = Effect.gen(function* () {
  const store = yield* AccountStore;
  const tokens = yield* AccountTokens;
  const states = yield* PoolStates;

  /**
   * Takes `account` out of rotation until `until` (epoch milliseconds), with a
   * warning that says why, unless it already is for at least that long or is
   * locked out. Says whether it did.
   */
  const coolDown = (account: Account, until: number, reason: string) =>
    Effect.gen(function* () {
      const cooled = yield* states.coolDown(account.id, until, reason);

      if (cooled) {
        yield* Effect.logWarning(
          `${account.label} is cooling down until ${new Date(until).toISOString()} (${reason})`,
        );
      }

      return cooled;
    });

  /** Takes `account` out of rotation until it logs in again, with a warning that says why. */
  const lockOut = (account: Account, reason: string) =>
    Effect.gen(function* () {
      yield* states.lockOut(account.id, reason);
      yield* Effect.logWarning(`${account.label} is locked out until it logs in again (${reason})`);
    });

  /**
   * Runs a refresh of `account`'s token, none when it fails: a dead refresh token
   * locks the account out; an auth-server hiccup cools it down for a minute.
   */
  const setAsideOnFailedRefresh =
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
    tokens.fresh(account).pipe(setAsideOnFailedRefresh(account));

  /** The accounts `allowed` lets serve a request, in the order they were added. */
  const accountsAllowed = (allowed: (accountId: string) => boolean) =>
    Effect.map(store.list, (accounts) => accounts.filter((account) => allowed(account.id)));

  /**
   * The account among those `allowed` the pool would use next, with a fresh
   * access token: `preferred` if it names one that is available, else
   * fill-first, skipping accounts cooling down or locked out. None once no
   * account can be used.
   */
  const next = (allowed: (accountId: string) => boolean, preferred: Option.Option<string>) =>
    Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const chosen = select(yield* accountsAllowed(allowed), yield* states.get, now, preferred);

        if (Option.isNone(chosen)) return Option.none<Account>();
        const fresh = yield* withFreshToken(chosen.value);

        if (Option.isSome(fresh)) return fresh;
      }
    });

  /**
   * How long until one of the accounts `allowed` stops cooling down; none when
   * none of them is cooling down.
   */
  const waitFor = (allowed: (accountId: string) => boolean) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      return retryAfter(yield* accountsAllowed(allowed), yield* states.get, now);
    });

  /**
   * Every account that serves requests, now or once its cooldown ends: enabled
   * and not locked out, in the order they were added.
   */
  const serving = Effect.map(Effect.all([store.list, states.get]), ([accounts, state]) =>
    pollable(accounts, state),
  );

  /**
   * `account` with a new access token after Codex refused the one it has, unless
   * another request already replaced it; none when refreshing fails, which sets
   * the account aside as {@link next} does.
   */
  const refreshRejected = (account: Account) =>
    tokens.refreshRejected(account.id, account.accessToken).pipe(setAsideOnFailedRefresh(account));

  return { next, waitFor, serving, withFreshToken, coolDown, lockOut, refreshRejected };
});

/**
 * The ChatGPT accounts as a pool: which one serves next, with a fresh token,
 * and taking one out of rotation, with a warning that says why.
 */
export class AccountPool extends Context.Service<AccountPool, Effect.Success<typeof make>>()(
  "via/AccountPool",
) {
  static readonly layer = Layer.effect(AccountPool, make);
}

/**
 * What ChatGPT says `account` has used of its rate limits, asked live, with its
 * access token refreshed first when about to expire. It needs no pool, so
 * `via accounts status` asks it too. A failed refresh fails it and sets nothing
 * aside: the admin API and `via accounts status` report why, and the usage poll
 * leaves that to the account's own next request.
 */
export const accountUsage = (account: Account) =>
  Effect.gen(function* () {
    const fresh = yield* (yield* AccountTokens).fresh(account);

    return yield* (yield* CodexUpstream).usage(fresh);
  });
