import { Data, Duration, Option, Schema } from "effect";

/** What a failed upstream response means for the account that got it. */
export type Verdict = Data.TaggedEnum<{
  /** Leave the account alone until `until`, then try it again. */
  Cooldown: { readonly until: number; readonly reason: string };
  /** The access token was refused: refresh it once and retry. */
  Unauthorized: {};
  /** The request itself is at fault; another account would fail the same way. */
  PassThrough: {};
}>;
export const Verdict = Data.taggedEnum<Verdict>();

const QUOTA_FALLBACK = Duration.minutes(30);
const TRANSIENT_COOLDOWN = Duration.minutes(1);

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

export const classify = (
  status: number,
  headers: Readonly<Record<string, string | undefined>>,
  body: string,
  now: number,
): Verdict => {
  const error = Option.map(decodeErrorBody(body), (b) => b.error);
  const code = Option.getOrUndefined(
    Option.flatMapNullishOr(error, (e) => e.code ?? e.type),
  );
  const resetsAt = Option.flatMapNullishOr(error, (e) =>
    e.resets_at === undefined ? undefined : e.resets_at * 1000,
  );
  const retryAt = Option.map(
    decodeSeconds(headers["retry-after"]),
    (s) => now + s * 1000,
  );

  if ((code !== undefined && QUOTA_CODES.has(code)) || status === 429) {
    const known = [resetsAt, retryAt].flatMap(Option.toArray);
    const until =
      known.length > 0
        ? Math.max(...known)
        : now + Duration.toMillis(QUOTA_FALLBACK);
    return Verdict.Cooldown({ until, reason: code ?? "rate_limited" });
  }
  if (status >= 500 || code === "server_is_overloaded") {
    return Verdict.Cooldown({
      until: now + Duration.toMillis(TRANSIENT_COOLDOWN),
      reason: code ?? `upstream_${status}`,
    });
  }
  if (status === 401) return Verdict.Unauthorized();
  return Verdict.PassThrough();
};
