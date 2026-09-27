import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import {
  type AccountState,
  type PoolState,
  type UsageWindow,
  decideUsagePoll,
  pollable,
} from "./index.ts";

const a = { id: "a", enabled: true };

const b = { id: "b", enabled: true };

const NOW = 1_000_000;

const isExhausted = (window: UsageWindow) => window.usedPercent >= 100 && window.resetsAt > NOW;

describe("pollable", () => {
  it("keeps an enabled account with no known state", () => {
    expect(pollable([a], {})).toEqual([a]);
  });

  it("keeps an enabled account that is currently cooling", () => {
    const state: PoolState = { a: { status: "cooling", until: NOW, reason: "quota" } };
    expect(pollable([a], state)).toEqual([a]);
  });

  it("drops an account locked out of the pool", () => {
    const state: PoolState = { a: { status: "auth_error", reason: "invalid_grant" } };
    expect(pollable([a, b], state)).toEqual([b]);
  });

  it("drops a disabled account", () => {
    expect(pollable([{ ...a, enabled: false }, b], {})).toEqual([b]);
  });

  it("preserves the accounts' order", () => {
    expect(pollable([b, a], {})).toEqual([b, a]);
  });
});

describe("decideUsagePoll", () => {
  it("does nothing when no window is exhausted", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 42, resetsAt: NOW + 1_000 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({ changed: false });
  });

  it("cools the account down until an exhausted window's reset", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 100, resetsAt: NOW + 60_000 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({
      changed: true,
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    });
  });

  it("treats a window over 100% used as exhausted too", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 137, resetsAt: NOW + 60_000 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({
      changed: true,
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    });
  });

  it("ignores an exhausted window whose reset has already passed", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 100, resetsAt: NOW - 1 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({ changed: false });
  });

  it("picks the latest reset when more than one window is exhausted", () => {
    const windows = [
      { windowMinutes: 300, usedPercent: 100, resetsAt: NOW + 60_000 },
      { windowMinutes: 300, usedPercent: 100, resetsAt: NOW + 120_000 },
    ];

    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({
      changed: true,
      until: NOW + 120_000,
      reason: "usage_limit_reached",
    });
  });

  it("extends an already-cooling account to a later verified reset", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 100, resetsAt: NOW + 120_000 }];

    const current = {
      status: "cooling",
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    } as const;

    expect(decideUsagePoll(windows, current, NOW)).toEqual({
      changed: true,
      until: NOW + 120_000,
      reason: "usage_limit_reached",
    });
  });

  it("never shortens a running cooldown", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 100, resetsAt: NOW + 30_000 }];

    const current = {
      status: "cooling",
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    } as const;

    expect(decideUsagePoll(windows, current, NOW)).toEqual({ changed: false });
  });

  it("never readmits a cooling account early, even when nothing is exhausted", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 12, resetsAt: NOW + 60_000 }];

    const current = {
      status: "cooling",
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    } as const;

    expect(decideUsagePoll(windows, current, NOW)).toEqual({ changed: false });
  });

  it("never turns an auth lockout into a mere cooldown, even with an exhausted window", () => {
    const windows = [{ windowMinutes: 300, usedPercent: 100, resetsAt: NOW + 60_000 }];
    const current = { status: "auth_error", reason: "invalid_grant" } as const;
    expect(decideUsagePoll(windows, current, NOW)).toEqual({ changed: false });
  });
});

describe("properties", () => {
  const WindowSpec = Schema.Struct({
    usedPercent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 150 })),
    resetsAtOffset: Schema.Int.check(Schema.isBetween({ minimum: -1_000, maximum: 1_000 })),
  });

  const windowSpecs = Arbitrary.array(Arbitrary.schema(WindowSpec), { minLength: 0, maxLength: 5 });

  /** A pool account's current state, restricted to what `decideUsagePoll` reads. */
  const CurrentSpec = Schema.Struct({
    kind: Schema.Literals(["none", "cooling", "auth_error"]),
    untilOffset: Schema.Int.check(Schema.isBetween({ minimum: -1_000, maximum: 1_000 })),
  });

  const currentSpecs = Arbitrary.schema(CurrentSpec);

  const toWindows = (specs: ReadonlyArray<typeof WindowSpec.Type>): ReadonlyArray<UsageWindow> =>
    specs.map((spec) => ({
      windowMinutes: 300,
      usedPercent: spec.usedPercent,
      resetsAt: NOW + spec.resetsAtOffset,
    }));

  const toCurrent = (spec: typeof CurrentSpec.Type): AccountState | undefined => {
    if (spec.kind === "none") return undefined;

    if (spec.kind === "auth_error") return { status: "auth_error", reason: "invalid_grant" };

    return { status: "cooling", until: NOW + spec.untilOffset, reason: "usage_limit_reached" };
  };

  it.prop(
    "only ever extends a running cooldown, never shortens or restates it",
    { windows: windowSpecs, current: currentSpecs },
    ({ windows, current }) => {
      const state = toCurrent(current);

      if (state?.status !== "cooling") return true;
      const result = decideUsagePoll(toWindows(windows), state, NOW);

      return !result.changed || result.until > state.until;
    },
  );

  it.prop(
    "a change cools until the latest exhausted reset, which is still ahead",
    { windows: windowSpecs, current: currentSpecs },
    ({ windows, current }) => {
      const usage = toWindows(windows);
      const result = decideUsagePoll(usage, toCurrent(current), NOW);

      if (!result.changed) return true;
      const exhausted = usage.filter(isExhausted);

      return (
        result.until > NOW &&
        exhausted.some((window) => window.resetsAt === result.until) &&
        exhausted.every((window) => window.resetsAt <= result.until)
      );
    },
  );

  it.prop(
    "leaves an account alone only when no exhausted window resets past its cooldown",
    { windows: windowSpecs, current: currentSpecs },
    ({ windows, current }) => {
      const usage = toWindows(windows);
      const state = toCurrent(current);

      if (decideUsagePoll(usage, state, NOW).changed || state?.status === "auth_error") return true;
      const until = state?.status === "cooling" ? state.until : NOW;

      return usage.filter(isExhausted).every((window) => window.resetsAt <= until);
    },
  );

  it.prop(
    "never turns an auth lockout into a mere cooldown",
    { windows: windowSpecs, current: currentSpecs },
    ({ windows, current }) => {
      const state = toCurrent(current);

      if (state?.status !== "auth_error") return true;
      expect(decideUsagePoll(toWindows(windows), state, NOW)).toEqual({ changed: false });

      return true;
    },
  );
});
