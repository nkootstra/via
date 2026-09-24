import { Clock, Context, Duration, Effect, Layer, Semaphore } from "effect";
import { AccountStore } from "./accounts.ts";
import { CodexAuth } from "./codex-auth.ts";

const REFRESH_WINDOW = Duration.minutes(5);

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

  /** The account with an access token valid for at least 5 more minutes. */
  const fresh = Effect.fn("AccountTokens.fresh")(function* (id: string) {
    const lock = yield* lockFor((yield* store.find(id)).id);
    return yield* Effect.gen(function* () {
      // Read under the lock, so a caller that waited sees the refresh it waited for.
      const account = yield* store.find(id);
      const now = yield* Clock.currentTimeMillis;
      if (account.expiresAt - now > Duration.toMillis(REFRESH_WINDOW)) return account;
      return yield* store.save(yield* auth.refresh(account));
    }).pipe(Semaphore.withPermit(lock));
  });

  return { fresh };
});

/** Hands out access tokens, refreshing and saving them shortly before they expire. */
export class AccountTokens extends Context.Service<AccountTokens, Effect.Success<typeof make>>()(
  "via/AccountTokens",
) {
  static readonly layer = Layer.effect(AccountTokens, make);
}
