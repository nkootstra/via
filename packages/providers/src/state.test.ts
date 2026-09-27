import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { providerState } from "./index.ts";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");

const at = (offset: number) => new Date(NOW + offset).toISOString();

const window = (name: string, usedPercent: number, offset: number) => ({
  window: name,
  status: "ok",
  usedPercent,
  resetsAt: at(offset),
});

describe("providerState", () => {
  it("is available for a provider that reports no usage", () => {
    expect(providerState(undefined, NOW)).toEqual({ status: "available" });
  });

  it("is available while every window has room left", () => {
    const usage = {
      provider: "opencode-go",
      windows: [window("rolling", 99.5, 60_000), window("monthly", 0, 120_000)],
    };

    expect(providerState(usage, NOW)).toEqual({ status: "available" });
  });

  it("is exhausted until a used-up window resets", () => {
    const usage = {
      provider: "opencode-go",
      windows: [window("rolling", 40, 60_000), window("weekly", 100, 3_600_000)],
    };

    expect(providerState(usage, NOW)).toEqual({
      status: "exhausted",
      until: at(3_600_000),
      window: "weekly",
    });
  });

  it("waits for the latest reset when several windows are used up", () => {
    const usage = {
      provider: "opencode-go",
      windows: [
        window("rolling", 100, 60_000),
        window("monthly", 100, 86_400_000),
        window("weekly", 100, 3_600_000),
      ],
    };

    expect(providerState(usage, NOW)).toEqual({
      status: "exhausted",
      until: at(86_400_000),
      window: "monthly",
    });
  });

  it("is available again once a used-up window's reset has passed", () => {
    const usage = { provider: "opencode-go", windows: [window("rolling", 100, 0)] };

    expect(providerState(usage, NOW)).toEqual({ status: "available" });
  });

  it("is unavailable, saying why, when its usage can't be read", () => {
    const usage = { provider: "opencode-go", error: "opencode-go did not report usage (HTTP 401)" };

    expect(providerState(usage, NOW)).toEqual({
      status: "unavailable",
      reason: "opencode-go did not report usage (HTTP 401)",
    });
  });
});

describe("properties", () => {
  const Window = Schema.Struct({
    usedPercent: Schema.Int.check(Schema.isBetween({ minimum: 90, maximum: 110 })),
    offset: Schema.Int.check(Schema.isBetween({ minimum: -1_000, maximum: 1_000 })),
  });

  const windows = Arbitrary.array(Arbitrary.schema(Window), { maxLength: 5 });

  const usageOf = (values: ReadonlyArray<typeof Window.Type>) => ({
    provider: "p",
    windows: values.map(({ usedPercent, offset }, i) => window(`w${i}`, usedPercent, offset)),
  });

  it.prop(
    "is exhausted exactly when a used-up window resets later, until the latest such reset",
    { windows },
    ({ windows: values }) => {
      const blocking = values.filter(({ usedPercent, offset }) => usedPercent >= 100 && offset > 0);
      const state = providerState(usageOf(values), NOW);

      if (blocking.length === 0) return state.status === "available";

      return (
        state.status === "exhausted" &&
        state.until === at(Math.max(...blocking.map(({ offset }) => offset)))
      );
    },
  );
});
