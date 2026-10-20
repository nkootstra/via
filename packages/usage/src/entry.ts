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
   * or the upstream's, such as `ModelProtocolUnsupported`, when it is an identifier.
   */
  error: Nullable(Schema.String),
  /**
   * Why, in via's own words. An upstream's message is never kept: it can quote
   * the request it refused.
   */
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
  /**
   * The conversation the request belongs to: the session or thread id its client sent,
   * or, without one, a hash of the conversation's opening. A sub-agent's is its own.
   */
  conversationId: Nullable(Schema.String),
  /** The conversation that started this one, for a sub-agent's request. */
  parentConversationId: Nullable(Schema.String),
  /** Where `conversationId` came from: a header's name, `body.<field>`, or `hash` for a guess. */
  sessionSource: Nullable(Schema.String),
  /** What kind of sub-agent sent the request, such as `review`, when its client says. */
  agentType: Nullable(Schema.String),
  /** The harness that sent it, with its version, as its User-Agent names it: `opencode/1.19.3`. */
  client: Nullable(Schema.String),
});

export type UsageEntry = typeof UsageEntry.Type;

/**
 * How an upstream attempt ended: `served`, its answer went to the client; `refused`, the
 * upstream refused the request itself and the client got that refusal; `failed`, it couldn't
 * serve, so via tried another account, protocol or model, or gave up.
 */
export const AttemptOutcome = Schema.Literals(["served", "refused", "failed"]);

/** Why an upstream attempt didn't serve, as via reads the upstream's answer. */
export const FailureCategory = Schema.Literals([
  "budget_exhausted",
  "rate_limited",
  "auth",
  "downstream_unavailable",
  "context_too_long",
  "content_filtered",
  "bad_request",
  "timeout",
  "network",
  "unknown",
]);

export type FailureCategory = typeof FailureCategory.Type;

/**
 * One upstream attempt of a request: an account or provider via sent it to, in
 * order, fallbacks included. Prompts and answers are never kept.
 */
export const RequestAttempt = Schema.Struct({
  requestId: Schema.String,
  /** Its place among the request's attempts, from 0. */
  seq: Schema.Finite,
  /** When via sent it, in epoch milliseconds. */
  startedAt: Schema.Finite,
  /** Until it failed, or, for the attempt that answered, until the answer ended. */
  durationMs: Schema.Finite,
  /** From `startedAt` to the first chunk of a streamed answer, for the attempt that answered. */
  firstChunkMs: Nullable(Schema.Finite),
  /** `codex`, `opencode-go`, or the name of the provider. */
  provider: Schema.String,
  model: Schema.String,
  accountId: Nullable(Schema.String),
  accountLabel: Nullable(Schema.String),
  /** The upstream's HTTP status; none when it was never reached or never answered. */
  status: Nullable(Schema.Finite),
  outcome: AttemptOutcome,
  /** Why it didn't serve; none for one that served. */
  category: Nullable(FailureCategory),
  /** The upstream's own error code or type, when it is an identifier. */
  upstreamCode: Nullable(Schema.String),
  /** The provider a router such as OpenRouter says it sent the request on to. */
  downstreamProvider: Nullable(Schema.String),
  /**
   * The upstream's error message, cut to 500 characters, kept only for a 401, 402, 403,
   * 429 or 5xx: answers about the account, its limits or the upstream itself, not the request.
   */
  message: Nullable(Schema.String),
});

export type RequestAttempt = typeof RequestAttempt.Type;
