import { Clock, Context, Duration, Effect, Layer, Predicate, Schedule, Semaphore } from "effect";
import { type Account, AccountStore } from "./accounts.ts";
import { CodexAuth, type RefreshRejectedError, type Tokens } from "./codex-auth.ts";

const REFRESH_WINDOW = Duration.minutes(5);

// A save that fails, e.g. on a busy lock or a full disk, is tried again a few times soon after:
// the old refresh token is already spent, so the new one is the only way back in.
const SAVE_RETRY = Schedule.exponential("50 millis");

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

  // Rotated tokens this process couldn't save, by account, with the refresh token still
  // stored in its place. That one is spent, so these are used instead until a save succeeds
  // or the stored one changes, as a login or another process's refresh changes it.
  const unsaved = new Map<string, { stored: string; tokens: Tokens }>();

  /**
   * Saves the rotated `tokens` of `stored`, the account as its file has it, or keeps them in
   * memory when it can't.
   */
  const saveRotation = (stored: Account, tokens: Tokens) =>
    store.saveRefreshed(stored.id, tokens).pipe(
      Effect.retry({
        schedule: SAVE_RETRY,
        times: 3,
        while: Predicate.not(Predicate.isTagged("AccountNotFoundError")),
      }),
      Effect.tap(() => Effect.sync(() => unsaved.delete(stored.id))),
      Effect.catchTag(["FileLockTimeoutError", "PlatformError"], (error) =>
        Effect.gen(function* () {
          unsaved.set(stored.id, { stored: stored.refreshToken, tokens });
          yield* Effect.logWarning(
            `Could not save the new tokens of ${stored.label}, so they are kept in memory until they can be (${error.message})`,
          );

          return { ...stored, ...tokens };
        }),
      ),
    );

  /**
   * `stored` with the rotated tokens this process couldn't save yet, saving them now if it
   * can; just `stored` when there are none, or they were rotated from tokens since replaced.
   */
  const current = Effect.fnUntraced(function* (stored: Account) {
    const pending = unsaved.get(stored.id);

    if (pending?.stored !== stored.refreshToken) {
      unsaved.delete(stored.id);

      return stored;
    }

    return yield* saveRotation(stored, pending.tokens);
  });

  /**
   * The account as another process refreshed it, after the issuer refused the refresh token
   * with `rejected`, perhaps because that process spent it: unless its file still holds
   * `stored`'s, as it did before the refresh, the refusal.
   */
  const refreshedElsewhere = Effect.fnUntraced(function* (
    stored: Account,
    rejected: RefreshRejectedError,
  ) {
    const latest = yield* store.read(stored.id);

    if (latest.refreshToken === stored.refreshToken) return yield* rejected;

    return yield* current(latest);
  });

  /**
   * Refreshes the account when `needed` says so, one refresh per account at a time, in this
   * process and across every via process.
   */
  const refreshIf = Effect.fn("AccountTokens.refreshIf")(function* (
    id: string,
    needed: (account: Account, now: number) => boolean,
  ) {
    const lock = yield* lockFor(id);

    return yield* Effect.gen(function* () {
      // Read under the locks, so a caller that waited sees the refresh it waited for,
      // whichever process made it.
      const stored = yield* store.read(id);
      const account = yield* current(stored);

      if (!needed(account, yield* Clock.currentTimeMillis)) return account;

      // The issuer spends the old refresh token once it answers, so a caller going away
      // mustn't stop the new one from being saved.
      return yield* Effect.uninterruptible(
        Effect.flatMap(auth.refresh(account), (tokens) => saveRotation(stored, tokens)),
      ).pipe(Effect.catchTag("RefreshRejectedError", (error) => refreshedElsewhere(stored, error)));
    }).pipe((refresh) => store.lockedForRefresh(id, refresh), Semaphore.withPermit(lock));
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
