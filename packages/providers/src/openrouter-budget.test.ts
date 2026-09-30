import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { budgetOf, nextReset } from "./openrouter-budget.ts";

const at = (iso: string) => Date.parse(iso);

const DAY = 86_400_000;

describe("nextReset", () => {
  it("resets a daily limit at the next midnight UTC", () => {
    expect(nextReset("daily", at("2026-09-30T13:45:00Z"))).toBe(at("2026-10-01T00:00:00Z"));
  });

  it("resets a weekly limit at the start of next Monday, UTC", () => {
    // 30 September 2026 is a Wednesday.
    expect(nextReset("weekly", at("2026-09-30T13:45:00Z"))).toBe(at("2026-10-05T00:00:00Z"));
    expect(nextReset("weekly", at("2026-10-05T00:00:00Z"))).toBe(at("2026-10-12T00:00:00Z"));
  });

  it("resets a monthly limit on the first of next month, UTC", () => {
    expect(nextReset("monthly", at("2026-12-31T23:59:59Z"))).toBe(at("2027-01-01T00:00:00Z"));
  });

  it.prop(
    "is always a later midnight UTC, within one of its periods",
    {
      window: Schema.Literals(["daily", "weekly", "monthly"]),
      now: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_102_444_800_000 })),
    },
    ({ window, now }) => {
      const reset = nextReset(window, now);
      const longest = { daily: DAY, weekly: 7 * DAY, monthly: 31 * DAY }[window];

      expect(reset).toBeGreaterThan(now);
      expect(reset - now).toBeLessThanOrEqual(longest);
      expect(reset % DAY).toBe(0);
    },
  );
});

describe("budgetOf", () => {
  const now = at("2026-09-30T13:45:00Z");

  it("reads a key's limit as a budget: what it spent of it, and when it resets", () => {
    expect(budgetOf({ limit: 10, limit_remaining: 6.8, limit_reset: "monthly" }, now)).toEqual({
      limitUsd: 10,
      spentUsd: 3.2,
      window: "monthly",
      resetsAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("reads a limit that never resets as one with no reset", () => {
    expect(budgetOf({ limit: 5, limit_remaining: 5, limit_reset: null }, now)).toEqual({
      limitUsd: 5,
      spentUsd: 0,
      window: null,
      resetsAt: null,
    });
  });

  it("has no budget for a key without a limit", () => {
    expect(budgetOf({ limit: null, limit_remaining: null, limit_reset: null }, now)).toBeNull();
  });
});
