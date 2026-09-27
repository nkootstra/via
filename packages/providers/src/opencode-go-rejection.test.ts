import { describe, expect, it } from "@effect/vitest";
import { classify, Verdict } from "@via/pool";
import { Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { rateLimitRejection } from "./opencode-go-rejection.ts";

const NOW = 1_700_000_000_000;

const MINUTE = 60_000;

const iso = (at: number) => new Date(at).toISOString();

/** When `classify` cools the account down for OpenCode Go's 429 with `usage` and `retryAfter`. */
const until = (...args: Parameters<typeof rateLimitRejection>) => {
  const verdict = classify(rateLimitRejection(...args), NOW);

  return Verdict.$is("Cooldown")(verdict) ? verdict : undefined;
};

describe("rateLimitRejection", () => {
  it("rests the account until its used-up window resets", () => {
    const usage = {
      provider: "opencode-go",
      windows: [
        { window: "rolling", status: "ok", usedPercent: 30, resetsAt: iso(NOW + MINUTE) },
        { window: "weekly", status: "limited", usedPercent: 100, resetsAt: iso(NOW + 60 * MINUTE) },
      ],
    };

    expect(until(usage, undefined, NOW)).toEqual(
      Verdict.Cooldown({ until: NOW + 60 * MINUTE, reason: "weekly_exhausted" }),
    );
  });

  it("rests it as long as Retry-After asks when no window is used up", () => {
    const usage = { provider: "opencode-go", error: "opencode-go did not report usage (HTTP 500)" };

    expect(until(usage, "120", NOW)).toEqual(
      Verdict.Cooldown({ until: NOW + 2 * MINUTE, reason: "rate_limited" }),
    );
  });

  const WindowSpec = Schema.Struct({
    usedPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 150 })),
    resetsAtOffset: Schema.Int.check(Schema.isBetween({ minimum: -3_600, maximum: 3_600 })),
  });

  const windows = Arbitrary.array(Arbitrary.schema(WindowSpec), { minLength: 0, maxLength: 4 });

  const retryAfters = Arbitrary.schema(
    Schema.UndefinedOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3_600 }))),
  );

  const usageOf = (specs: ReadonlyArray<typeof WindowSpec.Type>) => ({
    provider: "opencode-go",
    windows: specs.map((spec, index) => ({
      window: `w${index}`,
      status: "ok",
      usedPercent: spec.usedPercent,
      resetsAt: iso(NOW + spec.resetsAtOffset * 1000),
    })),
  });

  it.prop(
    "rests the account past now, past every used-up window's reset and past Retry-After",
    { specs: windows, retryAfter: retryAfters },
    ({ specs, retryAfter }) => {
      const cooldown = until(usageOf(specs), retryAfter?.toString(), NOW);

      if (cooldown === undefined) return false;

      const resets = specs
        .filter((spec) => spec.usedPercent >= 100 && spec.resetsAtOffset > 0)
        .map((spec) => NOW + spec.resetsAtOffset * 1000);

      return (
        cooldown.until > NOW &&
        resets.every((reset) => cooldown.until >= reset) &&
        (retryAfter === undefined || retryAfter === 0 || cooldown.until >= NOW + retryAfter * 1000)
      );
    },
  );
});
