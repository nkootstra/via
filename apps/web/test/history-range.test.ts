import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { historyBuckets, historyRange } from "../src/lib/history-range.ts";

const HOUR = 3_600_000;

const iso = (at: number) => new Date(at).toISOString();

describe("the usage history's hours, on Lord Howe Island", () => {
  // Lord Howe's clocks skip from 02:00 to 02:30 on 4 October 2026 (15:30 UTC on the 3rd).
  beforeAll(() => vi.stubEnv("TZ", "Australia/Lord_Howe"));

  afterAll(() => vi.unstubAllEnvs());

  it("starts each hour on the hour, as the server does, around a half-hour change", () => {
    const range = historyRange(1, "hour", Date.parse("2026-10-03T20:10:00Z"));
    const hours = historyBuckets(range, "hour").map(iso);

    expect(hours[0]).toBe("2026-10-02T20:30:00.000Z");
    expect(hours.slice(hours.indexOf("2026-10-03T14:30:00.000Z"))).toEqual([
      "2026-10-03T14:30:00.000Z",
      "2026-10-03T15:30:00.000Z",
      "2026-10-03T16:00:00.000Z",
      "2026-10-03T17:00:00.000Z",
      "2026-10-03T18:00:00.000Z",
      "2026-10-03T19:00:00.000Z",
      "2026-10-03T20:00:00.000Z",
    ]);
  });
});

describe("the usage history's range, in Amsterdam", () => {
  // Amsterdam moves its clocks back an hour at 03:00 on 25 October 2026.
  beforeAll(() => vi.stubEnv("TZ", "Europe/Amsterdam"));

  afterAll(() => vi.unstubAllEnvs());

  const now = Date.parse("2026-11-10T12:00:00Z");

  it("starts the days back at local midnight across a change of the clocks", () => {
    const range = historyRange(30, "day", now);

    expect([iso(range.from), iso(range.to)]).toEqual([
      "2026-10-11T22:00:00.000Z",
      "2026-11-10T23:00:00.000Z",
    ]);
  });

  it("gives a bar to each local day, the one with 25 hours too", () => {
    const days = historyBuckets(historyRange(30, "day", now), "day").map(iso);

    expect(days).toHaveLength(30);
    expect(days.slice(12, 15)).toEqual([
      "2026-10-23T22:00:00.000Z",
      "2026-10-24T22:00:00.000Z",
      "2026-10-25T23:00:00.000Z",
    ]);
  });

  it("gives a bar to each real hour, the repeated one too", () => {
    const hours = historyBuckets(
      historyRange(1, "hour", Date.parse("2026-10-25T12:30:00Z")),
      "hour",
    );

    expect(hours).toHaveLength(24);
    expect(hours.every((at, i) => i === 0 || at - (hours[i - 1] ?? 0) === HOUR)).toBe(true);
  });
});
