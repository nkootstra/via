import { Clock, Context, Duration, Effect, Layer, Semaphore } from "effect";
import { type Account, AccountStore } from "./accounts.ts";
import { CodexAuth } from "./codex-auth.ts";

const REFRESH_WINDOW = Duration.minutes(5);

const expiring = (account: Account, now: number) =>
  account.expiresAt - now <= Duration.toMillis(REFRESH_WINDOW);

const make = Effect.gen(function* () {
  const store = yield* AccountStore;
  const auth = yield* CodexAuth;
  // One refresh at a time per account: a refresh token is single-use, so a second
  // concurrent refresh would be rejected as reused and lock the account out.
  const locks = new Map<string, Semaphore.Semaphore>();

  const lockFor = (id: string) =>
    Effect.sync(() => {
      const lock = locks.get(id) ?? Semaphore.makeUnsafe(1);
      locks.set(id, lock);

      return lock;
    });

  /** Refreshes the account when `needed` says so, one refresh per account at a time. */
  const refreshIf = Effect.fn("AccountTokens.refreshIf")(function* (
    id: string,
    needed: (account: Account, now: number) => boolean,
  ) {
    const lock = yield* lockFor(id);

    return yield* Effect.gen(function* () {
      // Read under the lock, so a caller that waited sees the refresh it waited for.
      const account = yield* store.find(id);

      if (!needed(account, yield* Clock.currentTimeMillis)) return account;

      return yield* store.save(yield* auth.refresh(account));
    }).pipe(Semaphore.withPermit(lock));
  });

  /**
   * `account` with an access token valid for at least 5 more minutes. A token that
   * already is goes straight back, without taking the lock or reading the store again.
   * Untraced: it runs on every request, and a refresh shows up as `refreshIf`'s span.
   */
  const fresh = Effect.fnUntraced(function* (account: Account) {
    if (!expiring(account, yield* Clock.currentTimeMillis)) return account;

    return yield* refreshIf(account.id, expiring);
  });

  /**
   * The account with a new access token after upstream refused `rejectedToken`,
   * unless another caller has already replaced that token.
   */
  const refreshRejected = Effect.fn("AccountTokens.refreshRejected")(function* (
    id: string,
    rejectedToken: string,
  ) {
    return yield* refreshIf(id, (account) => account.accessToken === rejectedToken);
  });

  return { fresh, refreshRejected };
});

/** Hands out access tokens, refreshing and saving them shortly before they expire. */
export class AccountTokens extends Context.Service<AccountTokens, Effect.Success<typeof make>>()(
  "via/AccountTokens",
) {
  static readonly layer = Layer.effect(AccountTokens, make);
}
