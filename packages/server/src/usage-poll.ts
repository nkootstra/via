import { type Account, AccountStore, AccountTokens } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { decideUsagePoll, pollable, PoolStates } from "@via/pool";
import { coolDown } from "./accounts.ts";
import { Clock, Duration, Effect, Layer, Schedule } from "effect";

/** Not spammy: Codex's own usage endpoint, asked this often per account, at most. */
const POLL_INTERVAL = Duration.minutes(15);

/**
 * Asks Codex for `account`'s usage and applies what it means for the pool, leaving
 * the account's state untouched on any failure (network, 401, a refresh Codex
 * rejects): the account's own next request will surface that the same way it does
 * today. The poll never locks an account out and never retries within a pass.
 */
const pollOne = (account: Account) =>
  Effect.gen(function* () {
    const fresh = yield* (yield* AccountTokens).fresh(account);
    const windows = yield* (yield* CodexUpstream).usage(fresh);
    const states = yield* PoolStates;
    const now = yield* Clock.currentTimeMillis;
    const decision = decideUsagePoll(windows, (yield* states.get)[account.id], now);

    // The state may have changed since it was read; `coolDown` decides again on the latest.
    const cooled = decision.changed && (yield* coolDown(account, decision.until, decision.reason));

    if (!cooled) yield* Effect.logDebug(`${account.label}'s usage is unchanged`);
  }).pipe(
    Effect.catch((error) =>
      Effect.logDebug(`Could not poll ${account.label}'s usage: ${error.message}`),
    ),
  );

/** One account at a time, so a pass never bursts requests at Codex. */
const runPass = Effect.gen(function* () {
  const accounts = yield* (yield* AccountStore).list;
  const state = yield* (yield* PoolStates).get;
  yield* Effect.forEach(pollable(accounts, state), pollOne, { discard: true });
}).pipe(
  Effect.tapError((error) => Effect.logWarning(`usage poll pass failed: ${error.message}`)),
  Effect.ignore,
);

/**
 * Learns about an exhausted account from Codex's own `/wham/usage`, before the
 * account's own 429 would say so. Runs one pass every {@link POLL_INTERVAL}, the
 * first only after the first interval has passed, for as long as `via serve` runs.
 */
export const UsagePoll = {
  layer: Layer.effectDiscard(
    Effect.forkScoped(
      Effect.sleep(POLL_INTERVAL).pipe(
        Effect.andThen(Effect.repeat(runPass, Schedule.spaced(POLL_INTERVAL))),
      ),
    ),
  ),
};
