import type { FailureCategory } from "@via/usage";
import { Option, Schema } from "effect";
import type { HttpClientError } from "effect/http";

/** What via knows of an upstream attempt that didn't serve. */
export interface Failure {
  /** The upstream's HTTP status, when it answered. */
  readonly status: Option.Option<number>;
  /** The upstream's own error code or type. */
  readonly code: Option.Option<string>;
  /** The provider a router such as OpenRouter says it sent the request on to. */
  readonly downstreamProvider: Option.Option<string>;
  /** Why the upstream never answered, or broke off: it took too long, or the connection failed. */
  readonly cause: Option.Option<"timeout" | "network">;
}

/**
 * Each category an upstream's answer can fall in, in the order they are tried, with the
 * statuses that say it and what its own codes for it have in them, once lower-cased with
 * anything but letters and digits dropped: Codex's `usage_limit_reached`, OpenAI's
 * `insufficient_quota` and a `SubscriptionUsageLimitError` all read as a used-up budget.
 */
const CATEGORIES: ReadonlyArray<{
  readonly category: FailureCategory;
  readonly statuses: ReadonlyArray<number>;
  readonly codes: RegExp;
}> = [
  {
    category: "budget_exhausted",
    statuses: [402],
    codes:
      /quota|usagelimit|usagenotincluded|credit|spendlimit|budget|billing|insufficientbalance|paymentrequired/,
  },
  {
    category: "context_too_long",
    statuses: [413],
    codes: /contextlength|contextwindow|toolong|stringabovemaxlength|tokenlimitexceeded/,
  },
  {
    category: "content_filtered",
    statuses: [],
    codes: /contentfilter|contentpolicy|moderation|safety|policyviolation|flagged/,
  },
  { category: "rate_limited", statuses: [429], codes: /ratelimit|toomanyrequests/ },
  {
    category: "auth",
    statuses: [401, 403],
    codes: /invalidapikey|unauthorized|authentication|permissiondenied/,
  },
  {
    category: "downstream_unavailable",
    statuses: [502, 503, 504],
    codes: /overloaded|unavailable/,
  },
];

/**
 * Why an attempt didn't serve, from what the upstream said. A timeout or a broken connection
 * says it all; then a code via knows outranks the status, so a 429 that says the quota ran out
 * is a used-up budget, not a rate limit, and a 403 for a policy is a filter, not the account.
 * A router naming the provider it sent the request on to says that provider failed it.
 */
export const categorize = (failure: Failure): FailureCategory => {
  if (Option.isSome(failure.cause)) return failure.cause.value;

  const status = Option.getOrElse(failure.status, () => 0);

  const code = Option.map(failure.code, (found) =>
    found.toLowerCase().replaceAll(/[^a-z0-9]/g, ""),
  );

  const found = CATEGORIES.find(
    ({ statuses, codes }) =>
      statuses.includes(status) || Option.exists(code, (normal) => codes.test(normal)),
  );

  if (found !== undefined) return found.category;

  if (Option.isSome(failure.downstreamProvider)) return "downstream_unavailable";

  return status >= 400 && status < 500 ? "bad_request" : "unknown";
};

/**
 * A request Codex or a provider didn't answer in time: both fail it as a transport error
 * that says it gave "no answer within" the limit.
 */
const isUnanswered = Schema.is(
  Schema.Struct({ description: Schema.String.check(Schema.isPattern(/^no answer within /)) }),
);

/** Why an upstream couldn't be sent a request, or answer it: too slow, or out of reach. */
export const causeOf = (error: HttpClientError.HttpClientError): "timeout" | "network" =>
  isUnanswered(error.reason) ? "timeout" : "network";

/** The longest message kept, as `upstreamErrorOf` cuts one. */
const MESSAGE_LIMIT = 500;

/**
 * The upstream's `message` as the usage history keeps it: only for a 401, 402, 403, 429
 * or 5xx, cut to 500 characters.
 *
 * Those answers are about the account (its key refused, its budget or rate limit used up)
 * or the upstream itself (down, overloaded), which is what the words help diagnose, and
 * they don't look at what the request said, so they have nothing of it to quote. A 400,
 * 413 or 422, and anything else, judges the request itself and can quote its prompt back,
 * as `5_no_upstream_words` found, so its words are never kept.
 */
export const keptMessage = (status: Option.Option<number>, message: Option.Option<string>) =>
  Option.exists(
    status,
    (code) => code === 401 || code === 402 || code === 403 || code === 429 || code >= 500,
  )
    ? Option.map(message, (text) => text.slice(0, MESSAGE_LIMIT))
    : Option.none<string>();
