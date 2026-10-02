import { Rejection } from "@via/pool";
import { Data, Option, Schema } from "effect";

// Codex's own error mapping treats all of these as an exhausted account.
const QUOTA_CODES = new Set([
  "usage_limit_reached",
  "insufficient_quota",
  "usage_not_included",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

const CodexErrorBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.NullOr(Schema.String)),
      resets_at: Schema.optionalKey(Schema.Finite),
    }),
  }),
);

const decodeErrorBody = Schema.decodeUnknownOption(CodexErrorBody);

const decodeSeconds = Schema.decodeUnknownOption(Schema.FiniteFromString);

/**
 * What Codex means by answering `status` with `body`, in the pool's terms. A quota
 * code or a 429 outranks a server error or overload, which outranks a 401.
 */
export const readRejection = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
): Rejection => {
  const error = Option.map(decodeErrorBody(body), (b) => b.error);
  const code = Option.getOrUndefined(Option.flatMapNullishOr(error, (e) => e.code ?? e.type));

  const retryAfterMs = Option.getOrUndefined(
    Option.map(decodeSeconds(headers["retry-after"]), (s) => s * 1000),
  );

  if ((code !== undefined && QUOTA_CODES.has(code)) || status === 429) {
    const resetsAt = Option.flatMapNullishOr(error, (e) => e.resets_at).pipe(
      Option.map((seconds) => seconds * 1000),
    );

    return Rejection.Exhausted({
      reason: code ?? "rate_limited",
      resetsAt: Option.getOrUndefined(resetsAt),
      retryAfterMs,
    });
  }

  if (status >= 500 || code === "server_is_overloaded") {
    return Rejection.Unavailable({ reason: code ?? `upstream_${status}`, retryAfterMs });
  }

  if (status === 401) return Rejection.Unauthorized();

  return Rejection.Invalid();
};

// How codex itself finds the wait in a rate limit's message: "Please try again in 11.054s."
const RETRY_DELAY = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)\b/i;

/** The wait a failure's message asks for, in milliseconds. */
const retryDelayIn = (message: string) => {
  const found = RETRY_DELAY.exec(message);

  if (found === null) return undefined;

  const unit = found[2]?.toLowerCase() === "ms" ? 1 : 1000;

  return Option.getOrUndefined(
    Option.map(decodeSeconds(found[1]), (amount) => Math.round(amount * unit)),
  );
};

/**
 * What Codex means by failing a response in-stream with `code`, in the pool's
 * terms: a rate limit or quota code reads as the same code answered with 429.
 */
export const readFailure = (code: string, message: string): Rejection => {
  if (code === "rate_limit_exceeded" || QUOTA_CODES.has(code)) {
    return Rejection.Exhausted({ reason: code, retryAfterMs: retryDelayIn(message) });
  }

  if (code === "server_is_overloaded") return Rejection.Unavailable({ reason: code });

  return Rejection.Invalid();
};

/** Codex answered a request with something other than 200 OK. */
export class RequestRejectedError extends Data.TaggedError("RequestRejectedError")<{
  readonly status: number;
  readonly contentType: string | undefined;
  /** The answer's body, empty when it broke off. */
  readonly body: string;
  /** What the answer means for the account that sent the request. */
  readonly rejection: Rejection;
}> {
  override get message() {
    return `Codex rejected the request (HTTP ${this.status})`;
  }
}
