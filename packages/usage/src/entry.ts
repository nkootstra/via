// What the usage history keeps of a request. It imports only `effect`, so a browser can
// bundle it, as `@via/usage/entry`, to decode the admin API's answers.
import { Schema } from "effect";

const Nullable = <S extends Schema.Top>(schema: S) => Schema.OptionFromNullOr(schema);

/** One finished request, as the usage history keeps it. Prompts and answers are never kept. */
export const UsageEntry = Schema.Struct({
  requestId: Schema.String,
  /** When the request came in, in epoch milliseconds. */
  at: Schema.Finite,
  status: Schema.Finite,
  /**
   * Why the request failed, as a code: via's own, such as `rate_limit_exceeded`,
   * or the upstream's, such as `ModelProtocolUnsupported`.
   */
  error: Nullable(Schema.String),
  /** Why, in words: via's message, or the upstream's, cut to 500 characters. */
  errorMessage: Nullable(Schema.String),
  /** How a streamed answer ended: `completed`, `client_aborted` or `failed`. */
  streamEnd: Nullable(Schema.String),
  keyId: Nullable(Schema.String),
  /** The key's name when the request came in; a key can be renamed or revoked since. */
  keyName: Nullable(Schema.String),
  model: Schema.String,
  /** `codex`, `opencode-go`, or the name of the provider that served it. */
  provider: Schema.String,
  accountId: Nullable(Schema.String),
  /** The account's label when the request came in. */
  accountLabel: Nullable(Schema.String),
  inputTokens: Nullable(Schema.Finite),
  cachedTokens: Nullable(Schema.Finite),
  /** The part of `inputTokens` written to the upstream's prompt cache. */
  cacheWriteTokens: Nullable(Schema.Finite),
  outputTokens: Nullable(Schema.Finite),
  reasoningTokens: Nullable(Schema.Finite),
  /** What the upstream says it billed, in USD. */
  costUsd: Nullable(Schema.Finite),
  durationMs: Schema.Finite,
  firstChunkMs: Nullable(Schema.Finite),
  /** The model the client asked for, when it couldn't serve and `model` answered instead. */
  requestedModel: Nullable(Schema.String),
  /** Why the model asked for couldn't serve, as a code, such as `rate_limit_exceeded`. */
  fallbackReason: Nullable(Schema.String),
});

export type UsageEntry = typeof UsageEntry.Type;
