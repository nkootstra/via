import type { AccountState, PoolAccount, PoolState } from "./select.ts";

/** A rate-limit window's usage, structurally compatible with `@via/codex-upstream`'s `UsageWindow`. */
export type UsageWindow = {
  readonly usedPercent: number;
  /** Epoch milliseconds. */
  readonly resetsAt: number;
};

/** What a poll learned about an account's cooldown; `changed: false` leaves it untouched. */
export type UsagePollResult =
  | { readonly changed: false }
  | { readonly changed: true; readonly until: number; readonly reason: string };

const REASON = "usage_limit_reached";

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
 * never readmits it early — the payload has no reset-independent "allowed again"
 * signal via trusts.
 */
export const decideUsagePoll = (
  windows: ReadonlyArray<UsageWindow>,
  current: AccountState | undefined,
  now: number,
): UsagePollResult => {
  const exhausted = windows.filter((window) => window.usedPercent >= 100 && window.resetsAt > now);
  if (exhausted.length === 0) return { changed: false };
  const until = Math.max(...exhausted.map((window) => window.resetsAt));
  if (current?.status === "cooling" && until <= current.until) return { changed: false };
  return { changed: true, until, reason: REASON };
};
