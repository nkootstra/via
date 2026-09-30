/** How the usage page writes its numbers: tokens, dollars, durations and shares. */

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const whole = new Intl.NumberFormat("en-US");

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** A token count at a glance: 400, 4.4K, 1.2M. */
export const formatTokens = (tokens: number) => compact.format(tokens);

/** A count in full: 1,204. */
export const formatCount = (count: number) => whole.format(count);

/** Dollars to the cent; an amount under a cent that isn't nothing says so, not $0.00. */
export const formatUsd = (amount: number) =>
  amount > 0 && amount < 0.005 ? "<$0.01" : usd.format(amount);

/** A duration: 400 ms under a second, else 1.2 s. */
export const formatMs = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;

/** A share as a whole percentage, or a dash when there is nothing to share. */
export const formatShare = (part: number, total: number) =>
  total === 0 ? "–" : `${Math.round((part / total) * 100)}%`;

/** Tokens a group or a point spent: what it sent and what it got back. */
export const tokensOf = (usage: { readonly inputTokens: number; readonly outputTokens: number }) =>
  usage.inputTokens + usage.outputTokens;
