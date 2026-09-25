import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { type PoolState, retryAfter, select } from "./index.ts";

const a = { id: "a", enabled: true };
const b = { id: "b", enabled: true };
const c = { id: "c", enabled: true };
const NOW = 1_000_000;

describe("select", () => {
  it("fills the first account in order", () => {
    expect(select([a, b], {}, NOW)).toEqual(Option.some(a));
  });

  it("skips disabled accounts", () => {
    expect(select([{ ...a, enabled: false }, b], {}, NOW)).toEqual(Option.some(b));
  });

  it("skips an account that is cooling down", () => {
    const state: PoolState = {
      a: { status: "cooling", until: NOW + 1, reason: "quota" },
    };
    expect(select([a, b], state, NOW)).toEqual(Option.some(b));
  });

  it("uses a cooling account again once its cooldown has passed", () => {
    const state: PoolState = {
      a: { status: "cooling", until: NOW, reason: "quota" },
    };
    expect(select([a, b], state, NOW)).toEqual(Option.some(a));
  });

  it("skips an account whose login was rejected", () => {
    const state: PoolState = {
      a: { status: "auth_error", reason: "invalid_grant" },
    };
    expect(select([a, b], state, NOW)).toEqual(Option.some(b));
  });

  it("finds nothing when every account is unavailable", () => {
    const state: PoolState = {
      b: { status: "cooling", until: NOW + 1, reason: "quota" },
    };
    expect(select([{ ...a, enabled: false }, b], state, NOW)).toEqual(Option.none());
  });
});

describe("retryAfter", () => {
  it("is the time until the first enabled account comes out of cooldown", () => {
    const state: PoolState = {
      a: { status: "cooling", until: NOW + 5_000, reason: "quota" },
      b: { status: "cooling", until: NOW + 2_000, reason: "quota" },
      c: { status: "cooling", until: NOW + 1_000, reason: "quota" },
    };
    expect(retryAfter([a, b, { ...c, enabled: false }], state, NOW)).toEqual(Option.some(2_000));
  });

  it("is none when no account will recover by waiting", () => {
    const state: PoolState = {
      a: { status: "auth_error", reason: "invalid_grant" },
    };
    expect(retryAfter([a, { ...b, enabled: false }], state, NOW)).toEqual(Option.none());
  });
});
