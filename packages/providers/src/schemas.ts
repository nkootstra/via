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
