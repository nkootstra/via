import { classify, PoolStates, retryAfter, select, Verdict } from "@via/pool";
import { Clock, Context, Effect, Layer, type Option } from "effect";
import { type OpencodeGoAccount, OpencodeGoAccounts } from "./opencode-go-accounts.ts";
import { Providers } from "./providers.ts";
import { rateLimitRejection } from "./opencode-go-rejection.ts";

const make = Effect.gen(function* () {
  const accounts = yield* OpencodeGoAccounts;
  const states = yield* PoolStates;
  const providers = yield* Providers;

  /**
   * The account the pool would use next: `preferred` if it names one that is
   * available, else fill-first, skipping accounts cooling down or locked out.
   */
  const next = (preferred: Option.Option<string>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      return select(yield* accounts.list, yield* states.get, now, preferred);
    });

  /** How long until an account stops cooling down; none when none of them is. */
  const waitFor = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    return retryAfter(yield* accounts.list, yield* states.get, now);
  });

  /**
   * Takes `account` out of rotation until `until` (epoch milliseconds), with a
   * warning that says why, unless it already is for at least that long or is
   * locked out. Says whether it did.
   */
  const coolDown = (account: OpencodeGoAccount, until: number, reason: string) =>
    Effect.gen(function* () {
      const cooled = yield* states.coolDown(account.id, until, reason);

      if (cooled) {
        yield* Effect.logWarning(
          `${account.label} is cooling down until ${new Date(until).toISOString()} (${reason})`,
        );
      }

      return cooled;
    });

  /** Takes `account` out of rotation until via restarts, with a warning that says why. */
  const lockOut = (account: OpencodeGoAccount, reason: string) =>
    Effect.gen(function* () {
      yield* states.lockOut(account.id, reason);
      yield* Effect.logWarning(`${account.label} is locked out (${reason})`);
    });

  /**
   * Cools `account` down after opencode Go answered it 429: until its used-up
   * usage window resets or for as long as `retryAfterHeader` (the answer's
   * `Retry-After`) asks, whichever is later, and for half an hour when neither says.
   */
  const rateLimited = (account: OpencodeGoAccount, retryAfterHeader: string | undefined) =>
    Effect.gen(function* () {
      const usage = yield* providers.usage(account.apiKey);
      const now = yield* Clock.currentTimeMillis;
      const verdict = classify(rateLimitRejection(usage, retryAfterHeader, now), now);

      // An exhausted account always gets a cooldown.
      if (Verdict.$is("Cooldown")(verdict)) yield* coolDown(account, verdict.until, verdict.reason);
    });

  return { next, waitFor, coolDown, lockOut, rateLimited };
});

/**
 * The opencode Go accounts as a pool, sharing the Codex accounts' cooldowns:
 * which one serves next, and taking one out of rotation, with a warning that says why.
 */
export class OpencodeGoPool extends Context.Service<OpencodeGoPool, Effect.Success<typeof make>>()(
  "via/OpencodeGoPool",
) {
  static readonly layer = Layer.effect(OpencodeGoPool, make);
}
