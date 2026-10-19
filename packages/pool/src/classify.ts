import { Data, Duration, Predicate, Schema } from "effect";

/**
 * A reason the pool keeps for setting an account aside: an identifier, such as
 * `usage_limit_reached`. It is saved in `state.json`, logged and shown in the
 * admin API, and an upstream's code can be any text, even a quote of the request.
 */
const Reason = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,64}$/));

/** Whether `reason` is one the pool can keep. */
export const isReason = Schema.is(Reason);

/**
 * Why an upstream refused a request, in the pool's own terms: each upstream reads
 * its error format into one of these, and {@link classify} judges it.
 */
export type Rejection = Data.TaggedEnum<{
  /** The account used up its quota or hit a rate limit. */
  Exhausted: {
    /** Names the limit; kept as the account's cooldown reason. */
    readonly reason: string;
    /** When the upstream says the limit lifts, in epoch milliseconds. */
    readonly resetsAt?: number | undefined;
    /** How long the upstream asks to wait before trying again, in milliseconds. */
    readonly retryAfterMs?: number | undefined;
  };
  /** The upstream is failing or overloaded, whatever the account. */
  Unavailable: {
    /** Names the failure. */
    readonly reason: string;
    /** How long the upstream asks to wait before trying again, in milliseconds. */
    readonly retryAfterMs?: number | undefined;
  };
  /**
   * The account itself is barred for now (suspended, its workspace deactivated,
   * or blocked by a bot check), though its token is good.
   */
  Forbidden: {
    /** Names the refusal; kept as the account's cooldown reason. */
    readonly reason: string;
  };
  /** The access token was refused. */
  Unauthorized: {};
  /** The request itself is at fault. */
  Invalid: {};
}>;

export const Rejection = Data.taggedEnum<Rejection>();

/** What a failed upstream response means for the account that got it. */
export type Verdict = Data.TaggedEnum<{
  /** Leave the account alone until `until`, then try it again. */
  Cooldown: { readonly until: number; readonly reason: string };
  /**
   * The upstream is down or overloaded for every account alike: the account is
   * not to blame, and trying the others would only hit the same outage.
   */
  Unavailable: { readonly reason: string; readonly retryAfterMs?: number | undefined };
  /** The access token was refused: refresh it once and retry. */
  Unauthorized: {};
  /** The request itself is at fault; another account would fail the same way. */
  PassThrough: {};
}>;

export const Verdict = Data.taggedEnum<Verdict>();

const QUOTA_FALLBACK = Duration.minutes(30);

// Long enough not to hammer a barred account, short enough to notice it was let back in.
const FORBIDDEN_COOLDOWN = Duration.minutes(30);

export const classify = (rejection: Rejection, now: number): Verdict =>
  Rejection.$match(rejection, {
    Exhausted: ({ reason, resetsAt, retryAfterMs }) => {
      const retryAt = retryAfterMs === undefined ? undefined : now + retryAfterMs;
      // A reset or Retry-After already past says nothing about when the limit lifts,
      // and trusting it would put the account straight back into rotation.
      const ahead = [resetsAt, retryAt].filter(Predicate.isNotUndefined).filter((at) => at > now);

      const until = ahead.length > 0 ? Math.max(...ahead) : now + Duration.toMillis(QUOTA_FALLBACK);

      return Verdict.Cooldown({ until, reason });
    },
    Unavailable: ({ reason, retryAfterMs }) => Verdict.Unavailable({ reason, retryAfterMs }),
    Forbidden: ({ reason }) =>
      Verdict.Cooldown({ until: now + Duration.toMillis(FORBIDDEN_COOLDOWN), reason }),
    Unauthorized: () => Verdict.Unauthorized(),
    Invalid: () => Verdict.PassThrough(),
  });
