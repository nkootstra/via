import { describe, expect, it } from "@effect/vitest";
import { Rejection } from "@via/pool";
import { Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { readFailure, readRejection } from "./rejection.ts";

const RESETS_AT_SECONDS = 1_700_003_600;

// 2023-11-14T22:13:20Z
const NOW = 1_700_000_000_000;

const codexError = (error: Schema.JsonObject) => JSON.stringify({ error });

describe("readRejection", () => {
  const cases: ReadonlyArray<
    [name: string, status: number, headers: Record<string, string>, body: string, Rejection]
  > = [
    [
      "usage_limit_reached is exhausted until resets_at",
      429,
      {},
      codexError({ type: "usage_limit_reached", resets_at: RESETS_AT_SECONDS }),
      Rejection.Exhausted({ reason: "usage_limit_reached", resetsAt: RESETS_AT_SECONDS * 1000 }),
    ],
    [
      "Retry-After comes along in milliseconds",
      429,
      { "retry-after": "7200" },
      codexError({ type: "usage_limit_reached", resets_at: RESETS_AT_SECONDS }),
      Rejection.Exhausted({
        reason: "usage_limit_reached",
        resetsAt: RESETS_AT_SECONDS * 1000,
        retryAfterMs: 7_200_000,
      }),
    ],
    [
      "a Retry-After date counts from now",
      429,
      { "retry-after": "Tue, 14 Nov 2023 22:15:20 GMT" },
      "",
      Rejection.Exhausted({ reason: "rate_limited", retryAfterMs: 120_000 }),
    ],
    [
      "an outage's Retry-After date counts from now",
      503,
      { "retry-after": "Tue, 14 Nov 2023 22:13:21 GMT" },
      "",
      Rejection.Unavailable({ reason: "upstream_503", retryAfterMs: 1000 }),
    ],
    [
      "a Retry-After that is neither seconds nor a date is left out",
      429,
      { "retry-after": "soon" },
      "",
      Rejection.Exhausted({ reason: "rate_limited" }),
    ],
    [
      "a bare 429 is a rate limit",
      429,
      { "retry-after": "120" },
      "",
      Rejection.Exhausted({ reason: "rate_limited", retryAfterMs: 120_000 }),
    ],
    [
      "a quota code names the limit",
      429,
      {},
      codexError({ code: "insufficient_quota" }),
      Rejection.Exhausted({ reason: "insufficient_quota" }),
    ],
    [
      "usage_not_included is a quota error whatever the status",
      403,
      {},
      codexError({ type: "usage_not_included" }),
      Rejection.Exhausted({ reason: "usage_not_included" }),
    ],
    [
      "credit_balance_exhausted is a quota error whatever the status",
      400,
      {},
      codexError({ code: "credit_balance_exhausted" }),
      Rejection.Exhausted({ reason: "credit_balance_exhausted" }),
    ],
    [
      "organization_spend_limit_exceeded is a quota error whatever the status",
      400,
      {},
      codexError({ code: "organization_spend_limit_exceeded" }),
      Rejection.Exhausted({ reason: "organization_spend_limit_exceeded" }),
    ],
    [
      "project_spend_limit_exceeded is a quota error whatever the status",
      400,
      {},
      codexError({ code: "project_spend_limit_exceeded" }),
      Rejection.Exhausted({ reason: "project_spend_limit_exceeded" }),
    ],
    [
      "organization_usage_limit_exceeded is a quota error whatever the status",
      400,
      {},
      codexError({ code: "organization_usage_limit_exceeded" }),
      Rejection.Exhausted({ reason: "organization_usage_limit_exceeded" }),
    ],
    [
      "a server error is named by its status",
      502,
      {},
      "Bad Gateway",
      Rejection.Unavailable({ reason: "upstream_502" }),
    ],
    [
      "an outage keeps its Retry-After",
      503,
      { "retry-after": "1" },
      codexError({ code: "server_is_overloaded" }),
      Rejection.Unavailable({ reason: "server_is_overloaded", retryAfterMs: 1000 }),
    ],
    [
      "server_is_overloaded is unavailable whatever the status",
      400,
      {},
      codexError({ code: "server_is_overloaded" }),
      Rejection.Unavailable({ reason: "server_is_overloaded" }),
    ],
    ["a 401 refuses the token", 401, {}, "", Rejection.Unauthorized()],
    [
      "any other client error is the request's fault",
      400,
      {},
      codexError({ type: "invalid_request_error", message: "bad input" }),
      Rejection.Invalid(),
    ],
  ];

  for (const [name, status, headers, body, expected] of cases) {
    it(name, () => {
      expect(readRejection(status, headers, body, NOW)).toEqual(expected);
    });
  }

  /** A failed response with no reset hints: only its status and error code vary. */
  const Failure = Schema.Struct({
    status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
    code: Schema.Literals([
      "usage_limit_reached",
      "insufficient_quota",
      "server_is_overloaded",
      "invalid_request_error",
      "none",
    ]),
  });

  it.prop(
    "a quota code or 429 outranks a 5xx or overload, which outranks a 401",
    { failure: Arbitrary.schema(Failure) },
    ({ failure: { status, code } }) => {
      const body = code === "none" ? "" : codexError({ code });
      const named = code === "none" ? undefined : code;

      const expected =
        status === 429 || code === "usage_limit_reached" || code === "insufficient_quota"
          ? Rejection.Exhausted({ reason: named ?? "rate_limited" })
          : status >= 500 || code === "server_is_overloaded"
            ? Rejection.Unavailable({ reason: named ?? `upstream_${status}` })
            : status === 401
              ? Rejection.Unauthorized()
              : Rejection.Invalid();

      expect(readRejection(status, {}, body, NOW)).toEqual(expected);
    },
  );
});

describe("readFailure", () => {
  const cases: ReadonlyArray<[name: string, code: string, message: string, Rejection]> = [
    [
      "a rate limit waits as long as its message asks",
      "rate_limit_exceeded",
      "Rate limit reached. Please try again in 11.054s. Visit the docs.",
      Rejection.Exhausted({ reason: "rate_limit_exceeded", retryAfterMs: 11_054 }),
    ],
    [
      "a wait given in milliseconds",
      "rate_limit_exceeded",
      "Please try again in 250ms.",
      Rejection.Exhausted({ reason: "rate_limit_exceeded", retryAfterMs: 250 }),
    ],
    [
      "a rate limit that names no wait",
      "rate_limit_exceeded",
      "Rate limit reached.",
      Rejection.Exhausted({ reason: "rate_limit_exceeded" }),
    ],
    [
      "an overloaded Codex is unavailable",
      "server_is_overloaded",
      "busy",
      Rejection.Unavailable({ reason: "server_is_overloaded" }),
    ],
    [
      "any other failure is the request's",
      "context_length_exceeded",
      "too long",
      Rejection.Invalid(),
    ],
  ];

  for (const [name, code, message, expected] of cases) {
    it(name, () => {
      expect(readFailure(code, message)).toEqual(expected);
    });
  }

  it.prop(
    "a rate limit or quota code reads as the same code answered with 429",
    {
      code: Arbitrary.schema(
        Schema.Literals([
          "rate_limit_exceeded",
          "usage_limit_reached",
          "insufficient_quota",
          "usage_not_included",
          "credit_balance_exhausted",
        ]),
      ),
    },
    ({ code }) => {
      expect(readFailure(code, "limit reached")).toEqual(
        readRejection(429, {}, codexError({ code }), NOW),
      );
    },
  );
});
