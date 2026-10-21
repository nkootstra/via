/** How a request the usage history kept ended, as the usage page names it. */
import { Option } from "effect";
import type { UsageRequest } from "../api/types.ts";

/** The errors via answers itself, in a word or two; the code itself is the cell's title. */
const errorNames = new Map([
  ["rate_limit_exceeded", "Rate limited"],
  ["no_accounts", "No account"],
  ["upstream_unavailable", "Unreachable"],
  ["upstream_timeout", "Timed out"],
  ["upstream_too_large", "Too large"],
  ["invalid_request", "Bad request"],
  ["invalid_api_key", "Wrong key"],
  ["model_not_found", "Model not enabled"],
  ["upstream_unreadable", "Unreadable"],
  ["upstream_incomplete", "Broke off"],
]);

/** How a request ended, in a word or two. */
export const outcomeOf = (request: UsageRequest) =>
  Option.match(request.error, {
    onSome: (code) => errorNames.get(code) ?? code,
    onNone: () =>
      Option.contains(request.streamEnd, "failed")
        ? "Broke off"
        : request.status === 499
          ? "Client left"
          : request.status >= 400
            ? `Error ${request.status}`
            : "OK",
  });

/** The outcome's code or status, for its title. */
export const outcomeDetail = (request: UsageRequest) =>
  Option.getOrElse(request.error, () => `HTTP ${request.status}`);

/** Whether the request failed: an error via or the upstream answered, or a stream that broke off. */
export const failed = (request: UsageRequest) =>
  (request.status >= 400 && request.status !== 499) || Option.contains(request.streamEnd, "failed");

/** How a request ended, as a kind to colour: answered, failed, answered by a fallback, or left. */
export type OutcomeKind = "ok" | "failed" | "fellBack" | "aborted";

export const outcomeKind = (request: UsageRequest): OutcomeKind =>
  failed(request)
    ? "failed"
    : request.status === 499
      ? "aborted"
      : Option.isSome(request.requestedModel)
        ? "fellBack"
        : "ok";

/** Each kind's name, as a legend and a bar's name say it. */
export const outcomeKindNames: Readonly<Record<OutcomeKind, string>> = {
  ok: "OK",
  failed: "Failed",
  fellBack: "Fell back",
  aborted: "Client left",
};
