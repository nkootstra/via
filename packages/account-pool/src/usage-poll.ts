import { decideUsagePoll, pollable, PoolStates } from "@via/pool";
import { Clock, Duration, Effect, Layer, Schedule } from "effect";
import { AccountPool } from "./account-pool.ts";
import { type AccountUsageSnapshot, UsageSnapshots } from "./usage-snapshots.ts";

/** Not spammy: Codex's own usage endpoint, asked this often per account, at most. */
const POLL_INTERVAL = Duration.minutes(15);

/**
 * Applies what `entry`'s usage means for the pool, leaving the account's state
 * untouched when its usage couldn't be read (network, 401, a refresh Codex
 * rejects): the account's own next request will surface that the same way it
 * does today. The poll never locks an account out and never retries within a pass.
 */
const applyOne = (entry: AccountUsageSnapshot) =>
  Effect.gen(function* () {
    const { account } = entry;

    if ("error" in entry) {
      return yield* Effect.logDebug(`Could not poll ${account.label}'s usage: ${entry.error}`);
    }

    const states = yield* PoolStates;
    const now = yield* Clock.currentTimeMillis;
    const decision = decideUsagePoll(entry.windows, (yield* states.get)[account.id], now);

    // The state may have changed since it was read; `coolDown` decides again on the latest.
    const cooled =
      decision.changed &&
      (yield* (yield* AccountPool).coolDown(account, decision.until, decision.reason));

    if (!cooled) yield* Effect.logDebug(`${account.label}'s usage is unchanged`);
  });

/**
 * Refreshes the usage snapshots, which the dashboard shows too, and applies what
 * they say to every account the pool could use.
 */
const runPass = Effect.gen(function* () {
  const { accounts } = yield* (yield* UsageSnapshots).refresh;
  const state = yield* (yield* PoolStates).get;

  const polled = new Set(
    pollable(
      accounts.map(({ account }) => account),
      state,
    ),
  );

  yield* Effect.forEach(
    accounts.filter(({ account }) => polled.has(account)),
    applyOne,
    { discard: true },
  );
}).pipe(
  Effect.tapError((error) => Effect.logWarning(`usage poll pass failed: ${error.message}`)),
  Effect.ignore,
);

/**
 * Learns about an exhausted account from Codex's own `/wham/usage`, before the
 * account's own 429 would say so, and keeps the dashboard's usage current. Runs
 * one pass when `via serve` starts and one every {@link POLL_INTERVAL} after that,
 * for as long as it runs.
 */
export const UsagePoll = {
  layer: Layer.effectDiscard(
    Effect.forkScoped(Effect.repeat(runPass, Schedule.spaced(POLL_INTERVAL))),
  ),
};
