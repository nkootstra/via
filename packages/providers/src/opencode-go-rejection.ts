import { Rejection } from "@via/pool";
import { Option, Schema } from "effect";
import type { ProviderUsage } from "./schemas.ts";
import { providerState } from "./state.ts";

const decodeSeconds = Schema.decodeUnknownOption(Schema.FiniteFromString);

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

  return Rejection.Exhausted({
    reason: exhausted === undefined ? "rate_limited" : `${exhausted.window}_exhausted`,
    resetsAt: exhausted === undefined ? undefined : Date.parse(exhausted.until),
    retryAfterMs: Option.getOrUndefined(
      Option.map(decodeSeconds(retryAfter), (seconds) => seconds * 1000),
    ),
  });
};
