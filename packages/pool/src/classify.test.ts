import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { classify, Verdict } from "./index.ts";

const NOW = 1_700_000_000_000;

const SECOND = 1_000;

const MINUTE = 60 * SECOND;

const codexError = (error: object) => JSON.stringify({ error });

describe("classify", () => {
  const cases: ReadonlyArray<
    [name: string, status: number, headers: Record<string, string>, body: string, Verdict]
  > = [
    [
      "usage_limit_reached cools down until the reported reset",
      429,
      {},
      codexError({ type: "usage_limit_reached", resets_at: NOW / 1000 + 3600 }),
      Verdict.Cooldown({
        until: NOW + 60 * MINUTE,
        reason: "usage_limit_reached",
      }),
    ],
    [
      "a later Retry-After wins over resets_at",
      429,
      { "retry-after": "7200" },
      codexError({ type: "usage_limit_reached", resets_at: NOW / 1000 + 3600 }),
      Verdict.Cooldown({
        until: NOW + 120 * MINUTE,
        reason: "usage_limit_reached",
      }),
    ],
    [
      "a bare 429 cools down for Retry-After",
      429,
      { "retry-after": "120" },
      "",
      Verdict.Cooldown({ until: NOW + 2 * MINUTE, reason: "rate_limited" }),
    ],
    [
      "a quota error without reset time cools down for 30 minutes",
      429,
      {},
      codexError({ code: "insufficient_quota" }),
      Verdict.Cooldown({
        until: NOW + 30 * MINUTE,
        reason: "insufficient_quota",
      }),
    ],
    [
      "usage_not_included is a quota error whatever the status",
      403,
      {},
      codexError({ type: "usage_not_included" }),
      Verdict.Cooldown({
        until: NOW + 30 * MINUTE,
        reason: "usage_not_included",
      }),
    ],
    [
      "credit_balance_exhausted is a quota error whatever the status",
      400,
      {},
      codexError({ code: "credit_balance_exhausted" }),
      Verdict.Cooldown({
        until: NOW + 30 * MINUTE,
        reason: "credit_balance_exhausted",
      }),
    ],
    [
      "organization_spend_limit_exceeded is a quota error whatever the status",
      400,
      {},
      codexError({ code: "organization_spend_limit_exceeded" }),
      Verdict.Cooldown({
        until: NOW + 30 * MINUTE,
        reason: "organization_spend_limit_exceeded",
      }),
    ],
    [
      "project_spend_limit_exceeded is a quota error whatever the status",
      400,
      {},
      codexError({ code: "project_spend_limit_exceeded" }),
      Verdict.Cooldown({
        until: NOW + 30 * MINUTE,
        reason: "project_spend_limit_exceeded",
      }),
    ],
    [
      "organization_usage_limit_exceeded is a quota error whatever the status",
      400,
      {},
      codexError({ code: "organization_usage_limit_exceeded" }),
      Verdict.Cooldown({
        until: NOW + 30 * MINUTE,
        reason: "organization_usage_limit_exceeded",
      }),
    ],
    [
      "a server error cools down for a minute",
      502,
      {},
      "Bad Gateway",
      Verdict.Cooldown({ until: NOW + MINUTE, reason: "upstream_502" }),
    ],
    [
      "server_is_overloaded cools down for a minute",
      400,
      {},
      codexError({ code: "server_is_overloaded" }),
      Verdict.Cooldown({ until: NOW + MINUTE, reason: "server_is_overloaded" }),
    ],
    ["401 asks for a token refresh", 401, {}, "", Verdict.Unauthorized()],
    [
      "any other client error goes back to the client",
      400,
      {},
      codexError({ type: "invalid_request_error", message: "bad input" }),
      Verdict.PassThrough(),
    ],
  ];

  for (const [name, status, headers, body, expected] of cases) {
    it(name, () => {
      expect(classify(status, headers, body, NOW)).toEqual(expected);
    });
  }
});

describe("properties", () => {
  const QUOTA_CODE = "usage_limit_reached";

  /** A 429's resets_at/Retry-After, both possibly absent and possibly already in the past. */
  const CooldownInput = Schema.Struct({
    hasResetsAt: Schema.Boolean,
    resetsAtOffsetSeconds: Schema.Int.check(Schema.isBetween({ minimum: -7_200, maximum: 7_200 })),
    hasRetryAfter: Schema.Boolean,
    retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: -600, maximum: 7_200 })),
  });

  const inputs = Arbitrary.schema(CooldownInput);

  const toVerdict = (input: typeof CooldownInput.Type) => {
    const body = codexError({
      type: QUOTA_CODE,
      ...(input.hasResetsAt ? { resets_at: NOW / 1000 + input.resetsAtOffsetSeconds } : {}),
    });

    const headers = input.hasRetryAfter ? { "retry-after": String(input.retryAfterSeconds) } : {};

    return classify(429, headers, body, NOW);
  };

  it.prop("a Cooldown's until is never before now", { input: inputs }, ({ input }) =>
    Verdict.$match(toVerdict(input), {
      Cooldown: (verdict) => verdict.until >= NOW,
      Unauthorized: () => true,
      PassThrough: () => true,
    }),
  );

  it.prop(
    "until is the later of resets_at/Retry-After, or the fixed fallback",
    { input: inputs },
    ({ input }) => {
      const known = [
        input.hasResetsAt ? NOW + input.resetsAtOffsetSeconds * SECOND : undefined,
        input.hasRetryAfter ? NOW + input.retryAfterSeconds * SECOND : undefined,
      ].filter((value): value is number => value !== undefined);

      const until = Math.max(NOW, known.length > 0 ? Math.max(...known) : NOW + 30 * MINUTE);
      expect(toVerdict(input)).toEqual(Verdict.Cooldown({ until, reason: QUOTA_CODE }));
    },
  );
});
