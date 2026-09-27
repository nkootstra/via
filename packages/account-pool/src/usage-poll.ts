import { decideUsagePoll, pollable, PoolStates, type UsageWindow } from "@via/pool";
import { OpencodeGoPool } from "@via/providers";
import { Clock, Duration, Effect, Layer, Schedule } from "effect";
import { AccountPool } from "./account-pool.ts";
import {
  type AccountUsageSnapshot,
  type OpencodeGoUsageSnapshot,
  UsageSnapshots,
} from "./usage-snapshots.ts";

/** Not spammy: Codex's own usage endpoint, asked this often per account, at most. */
const POLL_INTERVAL = Duration.minutes(15);

/**
 * Applies what an account's usage `windows` mean for the pool, cooling it down
 * with `coolDown`, or says why its usage couldn't be read (network, 401, a
 * refresh Codex rejects) and leaves its state untouched: the account's own next
 * request will surface that the same way it does today. The poll never locks
 * an account out and never retries within a pass.
 */
const apply = <E, R>(
  account: { readonly id: string; readonly label: string },
  usage:
    | { readonly windows: ReadonlyArray<Pick<UsageWindow, "usedPercent" | "resetsAt">> }
    | {
        readonly error: string;
      },
  coolDown: (until: number, reason: string) => Effect.Effect<boolean, E, R>,
) =>
  Effect.gen(function* () {
    if ("error" in usage) {
      return yield* Effect.logDebug(`Could not poll ${account.label}'s usage: ${usage.error}`);
    }

    const states = yield* PoolStates;
    const now = yield* Clock.currentTimeMillis;
    const decision = decideUsagePoll(usage.windows, (yield* states.get)[account.id], now);

    // The state may have changed since it was read; `coolDown` decides again on the latest.
    const cooled = decision.changed && (yield* coolDown(decision.until, decision.reason));

    if (!cooled) yield* Effect.logDebug(`${account.label}'s usage is unchanged`);
  });

const applyOne = (entry: AccountUsageSnapshot) =>
  Effect.flatMap(AccountPool, (pool) =>
    apply(entry.account, entry, (until, reason) => pool.coolDown(entry.account, until, reason)),
  );

/** opencode Go's windows reset at an ISO 8601 time, not epoch milliseconds. */
const applyOpencodeGo = (entry: OpencodeGoUsageSnapshot) =>
  Effect.flatMap(OpencodeGoPool, (pool) =>
    apply(
      entry.account,
      "error" in entry
        ? entry
        : {
            windows: entry.windows.map(({ usedPercent, resetsAt }) => ({
              usedPercent,
              resetsAt: Date.parse(resetsAt),
            })),
          },
      (until, reason) => pool.coolDown(entry.account, until, reason),
    ),
  );

/**
 * Refreshes the usage snapshots, which the dashboard shows too, and applies what
 * they say to every account the pool could use.
 */
const runPass = Effect.gen(function* () {
  const { accounts, opencodeGo } = yield* (yield* UsageSnapshots).refresh;
  const state = yield* (yield* PoolStates).get;

  const polled = new Set<unknown>(
    pollable(
      [...accounts, ...opencodeGo].map(({ account }) => account),
      state,
    ),
  );

  yield* Effect.forEach(
    accounts.filter(({ account }) => polled.has(account)),
    applyOne,
    { discard: true },
  );

  yield* Effect.forEach(
    opencodeGo.filter(({ account }) => polled.has(account)),
    applyOpencodeGo,
    { discard: true },
  );
}).pipe(
  Effect.tapError((error) => Effect.logWarning(`usage poll pass failed: ${error.message}`)),
  Effect.ignore,
);

/**
 * Learns about an exhausted account from Codex's own `/wham/usage`, or opencode
 * Go's usage endpoint, before the account's own 429 would say so, and keeps the
 * dashboard's usage current. Runs
 * one pass when `via serve` starts and one every {@link POLL_INTERVAL} after that,
 * for as long as it runs.
 */
export const UsagePoll = {
  layer: Layer.effectDiscard(
    Effect.forkScoped(Effect.repeat(runPass, Schedule.spaced(POLL_INTERVAL))),
  ),
};
