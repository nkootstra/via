// Wire schemas the admin API's contract names. They import only `effect`, so the
// contract bundles for a browser without the providers' HTTP clients.
import { Schema } from "effect";

/**
 * A provider's usage windows, such as OpenCode Go's, or why it could not report
 * them. Each window says how much of one of its limits is used, and when it
 * starts over (ISO 8601, as the provider gives it).
 */
export const ProviderUsage = Schema.Union([
  Schema.Struct({
    provider: Schema.String,
    windows: Schema.Array(
      Schema.Struct({
        window: Schema.String,
        status: Schema.String,
        usedPercent: Schema.Finite,
        resetsAt: Schema.String,
      }),
    ),
  }),
  Schema.Struct({ provider: Schema.String, error: Schema.String }),
]);

export type ProviderUsage = typeof ProviderUsage.Type;

/**
 * Whether a provider has budget left: available, exhausted until a used-up
 * window resets (and which window), or unavailable when its usage can't be read.
 */
export const ProviderState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({
    status: Schema.Literal("exhausted"),
    until: Schema.String,
    window: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
]);

export type ProviderState = typeof ProviderState.Type;

/**
 * An OpenRouter key's budget: its limit in dollars, what it has spent of it,
 * and when it resets, if ever: daily, weekly (Monday) or monthly, at midnight UTC.
 */
export const OpenrouterBudget = Schema.Struct({
  limitUsd: Schema.Finite,
  spentUsd: Schema.Finite,
  window: Schema.NullOr(Schema.Literals(["daily", "weekly", "monthly"])),
  resetsAt: Schema.NullOr(Schema.String),
});

export type OpenrouterBudget = typeof OpenrouterBudget.Type;
