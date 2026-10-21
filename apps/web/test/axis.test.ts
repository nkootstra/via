import { Arbitrary, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MIN_TICK_GAP_PX,
  axisStep,
  axisTicks,
  formatTicks,
  isRoundStep,
  labelPlacement,
} from "../src/lib/axis.ts";

/** Checks `property` over generated values, failing with the shrunk counterexample. */
const holds = <A>(values: Arbitrary.Arbitrary<A>, property: (value: A) => boolean) => {
  const result = Effect.runSync(Arbitrary.checkEffect(values, property));

  expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
};

describe("axisStep", () => {
  it("picks a round step that leaves room for each label", () => {
    // 77 s across 1,000 px fits eight labels: 10 s apart, not a quarter of the span.
    expect(axisStep(77_000, 1_000)).toBe(10_000);
    // The same span squeezed into 300 px fits three: 30 s apart.
    expect(axisStep(77_000, 300)).toBe(30_000);
    expect(axisStep(14_000, 560)).toBe(5_000);
    expect(axisStep(3 * 3_600_000, 900)).toBe(30 * 60_000);
    expect(axisStep(800, 900)).toBe(100);
  });

  it("gives a track too narrow for two labels the whole span as one step", () => {
    expect(axisTicks(77_000, 60)).toEqual([0]);
  });
});

describe("axisTicks", () => {
  it("counts up from the start in steps, within the span", () => {
    expect(axisTicks(77_000, 1_000)).toEqual([
      0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000,
    ]);
  });

  const Axis = Schema.Struct({
    span: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 48 * 3_600_000 })),
    width: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_000 })),
  });

  it("never puts two labels closer than they need, nor a tick past the span", () => {
    holds(Arbitrary.schema(Axis), ({ span, width }) => {
      const ticks = axisTicks(span, width);
      const step = axisStep(span, width);
      const gap = (step / span) * width;

      return (
        ticks[0] === 0 &&
        isRoundStep(step) &&
        ticks.every((tick, index) => tick === index * step && tick <= span) &&
        (ticks.length === 1 || gap >= MIN_TICK_GAP_PX) &&
        ticks.length <= 9
      );
    });
  });

  it("takes the finest round step that leaves the labels room", () => {
    holds(Arbitrary.schema(Axis), ({ span, width }) => {
      const step = axisStep(span, width);

      const finer = [1, 2, 5, 10, 15, 20, 30, 50, 100, 200, 500]
        .flatMap((n) => [n, n * 1_000, n * 60_000, n * 3_600_000])
        .filter((candidate) => isRoundStep(candidate) && candidate < step);

      // Each finer step would crowd the labels, or draw more than nine ticks.
      return finer.every(
        (candidate) => (candidate / span) * width < MIN_TICK_GAP_PX || span / candidate > 8,
      );
    });
  });
});

describe("formatTicks", () => {
  it("names the ticks in the largest unit the axis reaches, each step whole or a tenth", () => {
    expect(formatTicks([0, 10_000, 20_000], 10_000)).toEqual(["0", "10 s", "20 s"]);
    expect(formatTicks([0, 15_000, 30_000, 45_000, 60_000, 75_000], 15_000)).toEqual([
      "0",
      "15 s",
      "30 s",
      "45 s",
      "60 s",
      "75 s",
    ]);
    expect(formatTicks([0, 500, 1_000, 1_500], 500)).toEqual(["0", "0.5 s", "1 s", "1.5 s"]);
    expect(formatTicks([0, 200, 400], 200)).toEqual(["0", "200 ms", "400 ms"]);
    expect(formatTicks([0, 30 * 60_000, 60 * 60_000, 90 * 60_000], 30 * 60_000)).toEqual([
      "0",
      "0.5 h",
      "1 h",
      "1.5 h",
    ]);
    expect(formatTicks([0, 60_000, 120_000], 60_000)).toEqual(["0", "1 min", "2 min"]);
    expect(formatTicks([0, 30_000, 60_000], 30_000)).toEqual(["0", "30 s", "60 s"]);
  });
});

describe("labelPlacement", () => {
  it("puts a bar's label after it, before it when there's no room after, else inside", () => {
    expect(labelPlacement({ start: 0.1, end: 0.2 }, 500, "1.7 s")).toBe("after");
    expect(labelPlacement({ start: 0.5, end: 0.99 }, 500, "1.7 s")).toBe("before");
    expect(labelPlacement({ start: 0, end: 0.99 }, 500, "1.7 s")).toBe("inside");
  });
});
