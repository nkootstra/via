import type { AccountState, PoolAccount, PoolState } from "./select.ts";

/** A rate-limit window's usage, structurally compatible with `@via/codex-upstream`'s `UsageWindow`. */
export type UsageWindow = {
  readonly usedPercent: number;
  /** Epoch milliseconds. */
  readonly resetsAt: number;
};

/** What a poll learned about an account's cooldown; `changed: false` leaves it untouched. */
type UsagePollResult =
  | { readonly changed: false }
  | { readonly changed: true; readonly until: number; readonly reason: string };

const REASON = "usage_limit_reached";

const UNCHANGED: UsagePollResult = { changed: false };

/** Every enabled account not locked out, including one already cooling: still worth polling. */
export const pollable = <A extends PoolAccount>(
  accounts: ReadonlyArray<A>,
  state: PoolState,
): ReadonlyArray<A> =>
  accounts.filter((account) => account.enabled && state[account.id]?.status !== "auth_error");

/**
 * What an account's `/wham/usage` windows mean for its cooldown, given its current
 * state. A window at 100% or more used, with a reset still ahead of `now`, is
 * exhausted; `until` is the latest such reset. An already-cooling account's `until`
 * is only ever extended, never shortened, and a poll that finds nothing exhausted
 * never readmits it early — `CodexUpstream.usage()` does not currently surface the
 * wire payload's `allowed`/`limit_reached` fields, so there is no reset-independent
 * "allowed again" signal here for via to trust yet.
 */
export const decideUsagePoll = (
  windows: ReadonlyArray<UsageWindow>,
  current: AccountState | undefined,
  now: number,
): UsagePollResult => {
  // A poll never touches an account already locked out of the pool: that lockout
  // means Codex rejected its refresh token, which no amount of usage data fixes.
  if (current?.status === "auth_error") return UNCHANGED;
  // Only an exhausted window resetting after both now and the running cooldown matters.
  const floor = current?.status === "cooling" ? Math.max(now, current.until) : now;
  let until = floor;

  for (const window of windows) {
    if (window.usedPercent >= 100 && window.resetsAt > until) until = window.resetsAt;
  }

  return until === floor ? UNCHANGED : { changed: true, until, reason: REASON };
};
