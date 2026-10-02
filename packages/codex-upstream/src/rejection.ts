import { Rejection } from "@via/pool";
import { Data, DateTime, Option, Schema } from "effect";

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

// Codex's code for a request its safety checks refuse, with 400 or 403: the request's fault, not the account's.
const MISALIGNMENT_POLICY_VIOLATION = "misalignment_policy_violation";

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

/** How long a `Retry-After` asks to wait, in milliseconds: seconds, or an HTTP date counted from `now`. */
const retryAfterIn = (header: string | undefined, now: number) =>
  Option.getOrUndefined(
    Option.orElse(
      Option.map(decodeSeconds(header), (seconds) => seconds * 1000),
      () =>
        Option.map(Option.flatMap(Option.fromNullishOr(header), DateTime.make), (at) =>
          Math.max(0, DateTime.toEpochMillis(at) - now),
        ),
    ),
  );

/**
 * What Codex means by answering `status` with `body` at `now` (epoch
 * milliseconds), in the pool's terms. A quota code or a 429 outranks a server
 * error or overload, which outranks a 401 or 403. A 403 bars the account
 * (suspended, deactivated, or blocked by Cloudflare), unless Codex refused the
 * request itself.
 */
export const readRejection = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
  now: number,
): Rejection => {
  const error = Option.map(decodeErrorBody(body), (b) => b.error);
  const code = Option.getOrUndefined(Option.flatMapNullishOr(error, (e) => e.code ?? e.type));

  const retryAfterMs = retryAfterIn(headers["retry-after"], now);

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

  if (status === 403 && code !== MISALIGNMENT_POLICY_VIOLATION) {
    return Rejection.Forbidden({ reason: code ?? "forbidden" });
  }

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
