import type { OpenrouterBudget } from "./schemas.ts";

type Window = "daily" | "weekly" | "monthly";

/**
 * When a limit resetting each `window` next resets after `now`, in epoch ms:
 * OpenRouter resets at midnight UTC, and its weeks run Monday to Sunday.
 */
export const nextReset = (window: Window, now: number) => {
  const day = new Date(now);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());

  switch (window) {
    case "daily":
      return midnight + 86_400_000;
    case "weekly": {
      // Days until next Monday: getUTCDay is 0 on Sunday, 1 on Monday.
      const ahead = (8 - day.getUTCDay()) % 7 || 7;

      return midnight + ahead * 86_400_000;
    }

    case "monthly":
      return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1);
  }
};

/** Dollars as OpenRouter's arithmetic leaves them, without float dust: 3.2, not 3.2000000000000002. */
const dollars = (amount: number) => Math.round(amount * 1_000_000) / 1_000_000;

/** A key's limit as a budget at `now`, or none for a key without a limit. */
export const budgetOf = (
  key: {
    readonly limit: number | null;
    readonly limit_remaining: number | null;
    readonly limit_reset: Window | null;
  },
  now: number,
): OpenrouterBudget | null => {
  if (key.limit === null) return null;

  return {
    limitUsd: key.limit,
    spentUsd: dollars(key.limit - (key.limit_remaining ?? key.limit)),
    window: key.limit_reset,
    resetsAt:
      key.limit_reset === null ? null : new Date(nextReset(key.limit_reset, now)).toISOString(),
  };
};
