import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { classify, Rejection, select, Verdict } from "./index.ts";

const NOW = 1_700_000_000_000;

const SECOND = 1_000;

const MINUTE = 60 * SECOND;

describe("classify", () => {
  const cases: ReadonlyArray<[name: string, Rejection, Verdict]> = [
    [
      "an exhausted account cools down until the reported reset",
      Rejection.Exhausted({ reason: "usage_limit_reached", resetsAt: NOW + 60 * MINUTE }),
      Verdict.Cooldown({ until: NOW + 60 * MINUTE, reason: "usage_limit_reached" }),
    ],
    [
      "a later Retry-After wins over the reset",
      Rejection.Exhausted({
        reason: "usage_limit_reached",
        resetsAt: NOW + 60 * MINUTE,
        retryAfterMs: 120 * MINUTE,
      }),
      Verdict.Cooldown({ until: NOW + 120 * MINUTE, reason: "usage_limit_reached" }),
    ],
    [
      "an exhausted account with only Retry-After cools down for it",
      Rejection.Exhausted({ reason: "rate_limited", retryAfterMs: 2 * MINUTE }),
      Verdict.Cooldown({ until: NOW + 2 * MINUTE, reason: "rate_limited" }),
    ],
    [
      "a reset already past counts as no reset time",
      Rejection.Exhausted({
        reason: "usage_limit_reached",
        resetsAt: NOW - MINUTE,
        retryAfterMs: 0,
      }),
      Verdict.Cooldown({ until: NOW + 30 * MINUTE, reason: "usage_limit_reached" }),
    ],
    [
      "an exhausted account without reset time cools down for 30 minutes",
      Rejection.Exhausted({ reason: "insufficient_quota" }),
      Verdict.Cooldown({ until: NOW + 30 * MINUTE, reason: "insufficient_quota" }),
    ],
    [
      "an unavailable upstream is not the account's fault",
      Rejection.Unavailable({ reason: "upstream_502" }),
      Verdict.Unavailable({ reason: "upstream_502" }),
    ],
    [
      "an unavailable upstream keeps its Retry-After",
      Rejection.Unavailable({ reason: "server_is_overloaded", retryAfterMs: SECOND }),
      Verdict.Unavailable({ reason: "server_is_overloaded", retryAfterMs: SECOND }),
    ],
    [
      "a forbidden account cools down for 30 minutes",
      Rejection.Forbidden({ reason: "forbidden" }),
      Verdict.Cooldown({ until: NOW + 30 * MINUTE, reason: "forbidden" }),
    ],
    ["a refused token asks for a refresh", Rejection.Unauthorized(), Verdict.Unauthorized()],
    ["an invalid request goes back to the client", Rejection.Invalid(), Verdict.PassThrough()],
  ];

  for (const [name, rejection, expected] of cases) {
    it(name, () => {
      expect(classify(rejection, NOW)).toEqual(expected);
    });
  }
});

describe("properties", () => {
  const REASON = "usage_limit_reached";

  /** An exhausted account's reset and Retry-After, both possibly absent and possibly already past. */
  const CooldownInput = Schema.Struct({
    hasResetsAt: Schema.Boolean,
    resetsAtOffsetSeconds: Schema.Int.check(Schema.isBetween({ minimum: -7_200, maximum: 7_200 })),
    hasRetryAfter: Schema.Boolean,
    retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: -600, maximum: 7_200 })),
  });

  const inputs = Arbitrary.schema(CooldownInput);

  const toVerdict = (input: typeof CooldownInput.Type) =>
    classify(
      Rejection.Exhausted({
        reason: REASON,
        ...(input.hasResetsAt ? { resetsAt: NOW + input.resetsAtOffsetSeconds * SECOND } : {}),
        ...(input.hasRetryAfter ? { retryAfterMs: input.retryAfterSeconds * SECOND } : {}),
      }),
      NOW,
    );

  it.prop(
    "a Cooldown takes the account out of rotation right away",
    { input: inputs },
    ({ input }) =>
      Verdict.$match(toVerdict(input), {
        Cooldown: ({ until, reason }) => {
          const account = { id: "a", enabled: true };
          const state = { a: { status: "cooling", until, reason } } as const;

          return Option.isNone(select([account], state, NOW));
        },
        Unavailable: () => false,
        Unauthorized: () => false,
        PassThrough: () => false,
      }),
  );

  it.prop(
    "a forbidden account is out of rotation for 30 minutes, then back",
    {
      reason: Arbitrary.schema(Schema.String),
      elapsedSeconds: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3_600 })),
      ),
    },
    ({ reason, elapsedSeconds }) =>
      Verdict.$match(classify(Rejection.Forbidden({ reason }), NOW), {
        Cooldown: ({ until }) => {
          const account = { id: "a", enabled: true };
          const state = { a: { status: "cooling", until, reason } } as const;
          const at = NOW + elapsedSeconds * SECOND;

          return Option.isSome(select([account], state, at)) === at >= NOW + 30 * MINUTE;
        },
        Unavailable: () => false,
        Unauthorized: () => false,
        PassThrough: () => false,
      }),
  );

  it.prop(
    "an unavailable upstream never takes an account out of rotation",
    {
      reason: Arbitrary.schema(Schema.String),
      retryAfterMs: Arbitrary.schema(Schema.UndefinedOr(Schema.Int)),
    },
    ({ reason, retryAfterMs }) =>
      !Verdict.$is("Cooldown")(classify(Rejection.Unavailable({ reason, retryAfterMs }), NOW)),
  );

  it.prop(
    "until is the later of the reset/Retry-After still ahead, or the fixed fallback",
    { input: inputs },
    ({ input }) => {
      const ahead = [
        input.hasResetsAt ? NOW + input.resetsAtOffsetSeconds * SECOND : undefined,
        input.hasRetryAfter ? NOW + input.retryAfterSeconds * SECOND : undefined,
      ].filter((value): value is number => value !== undefined && value > NOW);

      const until = ahead.length > 0 ? Math.max(...ahead) : NOW + 30 * MINUTE;
      expect(toVerdict(input)).toEqual(Verdict.Cooldown({ until, reason: REASON }));
    },
  );
});
