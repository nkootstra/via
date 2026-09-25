import { describe, expect, it } from "@effect/vitest";
import { type PoolState, decideUsagePoll, pollable } from "./index.ts";

const a = { id: "a", enabled: true };
const b = { id: "b", enabled: true };
const NOW = 1_000_000;

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
    const windows = [{ usedPercent: 42, resetsAt: NOW + 1_000 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({ changed: false });
  });

  it("cools the account down until an exhausted window's reset", () => {
    const windows = [{ usedPercent: 100, resetsAt: NOW + 60_000 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({
      changed: true,
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    });
  });

  it("treats a window over 100% used as exhausted too", () => {
    const windows = [{ usedPercent: 137, resetsAt: NOW + 60_000 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({
      changed: true,
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    });
  });

  it("ignores an exhausted window whose reset has already passed", () => {
    const windows = [{ usedPercent: 100, resetsAt: NOW - 1 }];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({ changed: false });
  });

  it("picks the latest reset when more than one window is exhausted", () => {
    const windows = [
      { usedPercent: 100, resetsAt: NOW + 60_000 },
      { usedPercent: 100, resetsAt: NOW + 120_000 },
    ];
    expect(decideUsagePoll(windows, undefined, NOW)).toEqual({
      changed: true,
      until: NOW + 120_000,
      reason: "usage_limit_reached",
    });
  });

  it("extends an already-cooling account to a later verified reset", () => {
    const windows = [{ usedPercent: 100, resetsAt: NOW + 120_000 }];
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
    const windows = [{ usedPercent: 100, resetsAt: NOW + 30_000 }];
    const current = {
      status: "cooling",
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    } as const;
    expect(decideUsagePoll(windows, current, NOW)).toEqual({ changed: false });
  });

  it("never readmits a cooling account early, even when nothing is exhausted", () => {
    const windows = [{ usedPercent: 12, resetsAt: NOW + 60_000 }];
    const current = {
      status: "cooling",
      until: NOW + 60_000,
      reason: "usage_limit_reached",
    } as const;
    expect(decideUsagePoll(windows, current, NOW)).toEqual({ changed: false });
  });

  it("never turns an auth lockout into a mere cooldown, even with an exhausted window", () => {
    const windows = [{ usedPercent: 100, resetsAt: NOW + 60_000 }];
    const current = { status: "auth_error", reason: "invalid_grant" } as const;
    expect(decideUsagePoll(windows, current, NOW)).toEqual({ changed: false });
  });
});
