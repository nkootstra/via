import type { ProviderState, ProviderUsage } from "./schemas.ts";

/**
 * A provider's state at `now`, from the usage it reported (`undefined` when it
 * reports none). A window at 100% makes it exhausted until that window resets;
 * with several, until the last of them does. A reset that has passed no longer
 * counts, as the provider has started that window over.
 */
export const providerState = (usage: ProviderUsage | undefined, now: number): ProviderState => {
  if (usage === undefined) return { status: "available" };

  if ("error" in usage) return { status: "unavailable", reason: usage.error };

  let latest: { window: string; resetsAt: number } | undefined;

  for (const { window, usedPercent, resetsAt } of usage.windows) {
    const reset = Date.parse(resetsAt);

    if (usedPercent >= 100 && reset > now && (latest === undefined || reset > latest.resetsAt)) {
      latest = { window, resetsAt: reset };
    }
  }

  return latest === undefined
    ? { status: "available" }
    : {
        status: "exhausted",
        until: new Date(latest.resetsAt).toISOString(),
        window: latest.window,
      };
};
