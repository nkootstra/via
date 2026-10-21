import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Option, Schema } from "effect";
import { categorize, type Failure, keptMessage } from "./failure.ts";

/** A failure with `status` and nothing else said, unless `overrides` say it. */
const failure = (status: number | undefined, overrides: Partial<Failure> = {}): Failure => ({
  status: Option.fromUndefinedOr(status),
  code: Option.none(),
  downstreamProvider: Option.none(),
  cause: Option.none(),
  ...overrides,
});

const code = (name: string) => ({ code: Option.some(name) });

const anyFailure = (status: number | undefined, found: string | undefined) =>
  failure(status, { code: Option.fromUndefinedOr(found) });

describe("categorize", () => {
  it("names a used-up budget, by its code or a 402", () => {
    expect(categorize(failure(429, code("usage_limit_reached")))).toBe("budget_exhausted");
    expect(categorize(failure(429, code("insufficient_quota")))).toBe("budget_exhausted");
    expect(categorize(failure(200, code("usage_not_included")))).toBe("budget_exhausted");
    expect(categorize(failure(402))).toBe("budget_exhausted");
    // Other upstreams' own names for it.
    expect(categorize(failure(429, code("SubscriptionUsageLimitError")))).toBe("budget_exhausted");
    expect(categorize(failure(403, code("credit_balance_exhausted")))).toBe("budget_exhausted");
  });

  it("names a rate limit, an account refused and a request refused", () => {
    expect(categorize(failure(429))).toBe("rate_limited");
    expect(categorize(failure(429, code("rate_limit_exceeded")))).toBe("rate_limited");
    expect(categorize(failure(401))).toBe("auth");
    expect(categorize(failure(403, code("forbidden")))).toBe("auth");
    expect(categorize(failure(400, code("invalid_request_error")))).toBe("bad_request");
    expect(categorize(failure(422))).toBe("bad_request");
  });

  it("names a provider that's down, or one a router sent the request on to that failed", () => {
    expect(categorize(failure(502))).toBe("downstream_unavailable");
    expect(categorize(failure(503))).toBe("downstream_unavailable");
    expect(categorize(failure(504))).toBe("downstream_unavailable");
    expect(categorize(failure(200, code("server_is_overloaded")))).toBe("downstream_unavailable");

    expect(
      categorize(failure(400, { downstreamProvider: Option.some("Together"), ...code("400") })),
    ).toBe("downstream_unavailable");
  });

  it("names a request too long for the model, and one its filters refused", () => {
    expect(categorize(failure(400, code("context_length_exceeded")))).toBe("context_too_long");
    expect(categorize(failure(413))).toBe("context_too_long");
    expect(categorize(failure(400, code("content_filter")))).toBe("content_filtered");
    expect(categorize(failure(403, code("misalignment_policy_violation")))).toBe(
      "content_filtered",
    );
  });

  it("names an upstream never reached or that never answered", () => {
    expect(categorize(failure(undefined, { cause: Option.some("network") }))).toBe("network");
    expect(categorize(failure(undefined, { cause: Option.some("timeout") }))).toBe("timeout");
  });

  it("says unknown for what it can't tell", () => {
    expect(categorize(failure(500))).toBe("unknown");
    expect(categorize(failure(200, code("server_error")))).toBe("unknown");
    expect(categorize(failure(undefined))).toBe("unknown");
  });

  const statuses = Arbitrary.schema(
    Schema.UndefinedOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  );

  const codes = Arbitrary.schema(Schema.UndefinedOr(Schema.String));

  it.prop(
    "names a timeout or a network failure whatever else is said",
    {
      status: statuses,
      found: codes,
      cause: Arbitrary.schema(Schema.Literals(["timeout", "network"])),
    },
    ({ status, found, cause }) =>
      categorize({ ...anyFailure(status, found), cause: Option.some(cause) }) === cause,
  );

  it.prop(
    "names a 402 a used-up budget whatever its code",
    { found: codes },
    ({ found }) => categorize(anyFailure(402, found)) === "budget_exhausted",
  );

  it.prop(
    "names a client error it has no name for a bad request",
    {
      status: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 499 })).check(
          Schema.makeFilter((status) => ![401, 402, 403, 413, 429].includes(status)),
        ),
      ),
    },
    ({ status }) => categorize(failure(status)) === "bad_request",
  );
});

describe("keptMessage", () => {
  const said = "You've hit your usage limit.";

  it("keeps the words of an answer about the account, its limits or the upstream", () => {
    for (const status of [401, 402, 403, 429, 500, 502, 503, 504]) {
      expect(keptMessage(Option.some(status), Option.some(said))).toEqual(Option.some(said));
    }
  });

  it("keeps none of an answer that could quote the request", () => {
    for (const status of [200, 400, 404, 413, 422]) {
      expect(keptMessage(Option.some(status), Option.some(said))).toEqual(Option.none());
    }

    expect(keptMessage(Option.none(), Option.some(said))).toEqual(Option.none());
  });

  it.prop(
    "keeps at most 500 characters, and only for a 401, 402, 403, 429 or 5xx",
    {
      status: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
      message: Arbitrary.schema(Schema.String),
    },
    ({ status, message }) => {
      const kept = keptMessage(Option.some(status), Option.some(message));
      const may = [401, 402, 403, 429].includes(status) || status >= 500;

      return may
        ? Option.isSome(kept) && kept.value.length <= 500 && message.startsWith(kept.value)
        : Option.isNone(kept);
    },
  );
});
