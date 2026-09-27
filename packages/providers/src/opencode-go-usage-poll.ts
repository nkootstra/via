import { decideUsagePoll, pollable, PoolStates } from "@via/pool";
import { Clock, Duration, Effect, Layer, Schedule } from "effect";
import { type OpencodeGoAccount, OpencodeGoAccounts } from "./opencode-go-accounts.ts";
import { OpencodeGoPool } from "./opencode-go-pool.ts";
import { Providers } from "./providers.ts";

/** Not spammy: the same interval as the ChatGPT accounts' poll. */
const POLL_INTERVAL = Duration.minutes(15);

/**
 * Asks opencode Go for `account`'s usage and applies what it means for the
 * pool, leaving the account's state untouched when its usage can't be read.
 */
const pollOne = (account: OpencodeGoAccount) =>
  Effect.gen(function* () {
    const usage = yield* (yield* Providers).usage(account.apiKey);

    if ("error" in usage) {
      return yield* Effect.logDebug(`Could not poll ${account.label}'s usage: ${usage.error}`);
    }

    const states = yield* PoolStates;
    const now = yield* Clock.currentTimeMillis;

    const decision = decideUsagePoll(
      usage.windows.map(({ usedPercent, resetsAt }) => ({
        usedPercent,
        resetsAt: Date.parse(resetsAt),
      })),
      (yield* states.get)[account.id],
      now,
    );

    // The state may have changed since it was read; `coolDown` decides again on the latest.
    const cooled =
      decision.changed &&
      (yield* (yield* OpencodeGoPool).coolDown(account, decision.until, decision.reason));

    if (!cooled) yield* Effect.logDebug(`${account.label}'s usage is unchanged`);
  });

/** One account at a time, so a pass never bursts requests at opencode Go. */
const runPass = Effect.gen(function* () {
  const accounts = yield* (yield* OpencodeGoAccounts).list;
  const state = yield* (yield* PoolStates).get;
  yield* Effect.forEach(pollable(accounts, state), pollOne, { discard: true });
}).pipe(
  Effect.tapError((error) => Effect.logWarning(`opencode Go usage poll failed: ${error.message}`)),
  Effect.ignore,
);

/**
 * Learns about a used-up opencode Go account from its usage endpoint, before
 * its own 429 would say so. Runs one pass every {@link POLL_INTERVAL}, the
 * first only after the first interval has passed, for as long as `via serve` runs.
 */
export const OpencodeGoUsagePoll = {
  layer: Layer.effectDiscard(
    Effect.forkScoped(
      Effect.sleep(POLL_INTERVAL).pipe(
        Effect.andThen(Effect.repeat(runPass, Schedule.spaced(POLL_INTERVAL))),
      ),
    ),
  ),
};
