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

  // Rotated tokens this process couldn't save, by account. The refresh tokens they replace
  // are spent, so these are used in place of the stored ones until a save succeeds.
  const unsaved = new Map<string, Tokens>();

  /** Saves `account`'s rotated `tokens`, or keeps them in memory when it can't. */
  const saveRotation = (account: Account, tokens: Tokens) =>
    store.saveRefreshed(account.id, tokens).pipe(
      Effect.retry({
        schedule: SAVE_RETRY,
        times: 3,
        while: Predicate.not(Predicate.isTagged("AccountNotFoundError")),
      }),
      Effect.tap(() => Effect.sync(() => unsaved.delete(account.id))),
      Effect.catchTag(["FileLockTimeoutError", "PlatformError"], (error) =>
        Effect.gen(function* () {
          unsaved.set(account.id, tokens);
          yield* Effect.logWarning(
            `Could not save the new tokens of ${account.label}, so they are kept in memory until they can be (${error.message})`,
          );

          return { ...account, ...tokens };
        }),
      ),
    );

  /** The stored account, with the rotated tokens it couldn't save yet, saving them now if it can. */
  const current = Effect.fnUntraced(function* (id: string) {
    const stored = yield* store.read(id);
    const pending = unsaved.get(id);

    return pending === undefined ? stored : yield* saveRotation(stored, pending);
  });

  /**
   * `account` as another process refreshed it, after the issuer refused its refresh token
   * with `rejected`, perhaps because that process spent it; else the refusal.
   */
  const refreshedElsewhere = (account: Account, rejected: RefreshRejectedError) =>
    Effect.flatMap(store.read(account.id), (stored) =>
      stored.refreshToken === account.refreshToken ? Effect.fail(rejected) : Effect.succeed(stored),
    );

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
      const account = yield* current(id);

      if (!needed(account, yield* Clock.currentTimeMillis)) return account;

      // The issuer spends the old refresh token once it answers, so a caller going away
      // mustn't stop the new one from being saved.
      return yield* Effect.uninterruptible(
        Effect.flatMap(auth.refresh(account), (tokens) => saveRotation(account, tokens)),
      ).pipe(
        Effect.catchTag("RefreshRejectedError", (error) => refreshedElsewhere(account, error)),
      );
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
