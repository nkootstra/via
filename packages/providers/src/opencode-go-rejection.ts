import { isReason, Rejection } from "@via/pool";
import { Option, Schema } from "effect";
import type { ProviderUsage } from "./schemas.ts";
import { providerState } from "./state.ts";

const decodeSeconds = Schema.decodeUnknownOption(Schema.FiniteFromString);

/** `Retry-After`, in seconds, as milliseconds; none when it isn't a number of seconds. */
const retryAfterMsOf = (retryAfter: string | undefined) =>
  Option.getOrUndefined(Option.map(decodeSeconds(retryAfter), (seconds) => seconds * 1000));

/**
 * What OpenCode Go's 429 means for the account that got it before via has
 * asked its usage: exhausted for as long as `retryAfter` (the answer's
 * `Retry-After`, in seconds) asks, else for `restMs`.
 */
export const provisionalRejection = (
  retryAfter: string | undefined,
  now: number,
  restMs: number,
): Rejection => {
  const retryAfterMs = retryAfterMsOf(retryAfter);

  return Rejection.Exhausted({
    reason: "rate_limited",
    resetsAt: retryAfterMs === undefined ? now + restMs : undefined,
    retryAfterMs,
  });
};

/**
 * What OpenCode Go's 429 means for the account that got it, in the pool's
 * terms: exhausted until its used-up usage window resets, per `usage` asked
 * right after, or for as long as `retryAfter` (the answer's `Retry-After`, in
 * seconds) asks; `classify` takes the later of them.
 */
export const rateLimitRejection = (
  usage: ProviderUsage,
  retryAfter: string | undefined,
  now: number,
): Rejection => {
  const state = providerState(usage, now);
  const exhausted = state.status === "exhausted" ? state : undefined;
  // The window's name is OpenCode Go's, so it names the cooldown only as an identifier.
  const named = exhausted === undefined ? undefined : `${exhausted.window}_exhausted`;

  return Rejection.Exhausted({
    reason: named !== undefined && isReason(named) ? named : "rate_limited",
    resetsAt: exhausted === undefined ? undefined : Date.parse(exhausted.until),
    retryAfterMs: retryAfterMsOf(retryAfter),
  });
};
