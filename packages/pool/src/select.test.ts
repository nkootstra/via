import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import {
  type AccountState,
  type PoolAccount,
  type PoolState,
  available,
  retryAfter,
  select,
} from "./index.ts";

const a = { id: "a", enabled: true };

const b = { id: "b", enabled: true };

const c = { id: "c", enabled: true };

const NOW = 1_000_000;

/** The independent spec of `isAvailable`, restated rather than imported. */
const expectAvailable = (state: PoolState, now: number) => (account: PoolAccount) => {
  const current = state[account.id];

  return (
    account.enabled &&
    (current === undefined || (current.status === "cooling" && current.until <= now))
  );
};

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

  it("prefers the given account over fill-first order when it is available", () => {
    expect(select([a, b, c], {}, NOW, Option.some("c"))).toEqual(Option.some(c));
  });

  it("falls back to fill-first when the preferred account is cooling down", () => {
    const state: PoolState = {
      b: { status: "cooling", until: NOW + 1, reason: "quota" },
    };

    expect(select([a, b, c], state, NOW, Option.some("b"))).toEqual(Option.some(a));
  });

  it("falls back to fill-first when the preferred account isn't in the list", () => {
    expect(select([a, b], {}, NOW, Option.some("nonexistent"))).toEqual(Option.some(a));
  });

  it("falls back to fill-first when nothing is preferred", () => {
    expect(select([a, b], {}, NOW, Option.none())).toEqual(Option.some(a));
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

describe("properties", () => {
  /** One account's state recipe: absent, cooling by an offset from `now`, or locked out. */
  const Spec = Schema.Struct({
    enabled: Schema.Boolean,
    kind: Schema.Literals(["none", "cooling", "auth_error"]),
    offset: Schema.Int.check(Schema.isBetween({ minimum: -1_000, maximum: 1_000 })),
    reason: Schema.Literals(["quota", "server_error", "invalid_grant"]),
  });

  const specs = Arbitrary.array(Arbitrary.schema(Spec), { minLength: 1, maxLength: 8 });

  /** Builds accounts (unique, index-based ids) and the matching PoolState from specs. */
  const build = (values: ReadonlyArray<typeof Spec.Type>) => {
    const accounts: ReadonlyArray<PoolAccount> = values.map((spec, i) => ({
      id: `acc-${i}`,
      enabled: spec.enabled,
    }));

    const state: PoolState = Object.fromEntries(
      values.flatMap((spec, i): ReadonlyArray<readonly [string, AccountState]> => {
        if (spec.kind === "cooling") {
          return [
            [`acc-${i}`, { status: "cooling", until: NOW + spec.offset, reason: spec.reason }],
          ];
        }

        if (spec.kind === "auth_error") {
          return [[`acc-${i}`, { status: "auth_error", reason: spec.reason }]];
        }

        return [];
      }),
    );

    return { accounts, state };
  };

  it.prop(
    "never selects a disabled, locked-out, or still-cooling account",
    { specs },
    ({ specs: values }) => {
      const { accounts, state } = build(values);

      return Option.match(select(accounts, state, NOW), {
        onNone: () => true,
        onSome: expectAvailable(state, NOW),
      });
    },
  );

  it.prop(
    "selects the first entry of `available`, or none when it is empty",
    { specs },
    ({ specs: values }) => {
      const { accounts, state } = build(values);
      const found = available(accounts, state, NOW);
      const expected = found.length > 0 ? Option.some(found[0]) : Option.none();
      expect(select(accounts, state, NOW)).toEqual(expected);
    },
  );

  it.prop("`available` is exactly the available ids, in order", { specs }, ({ specs: values }) => {
    const { accounts, state } = build(values);
    const expectedIds = accounts.filter(expectAvailable(state, NOW)).map((account) => account.id);
    expect(available(accounts, state, NOW).map((account) => account.id)).toEqual(expectedIds);
  });

  it.prop(
    "retryAfter is the minimum wait over enabled cooling accounts, else none",
    { specs },
    ({ specs: values }) => {
      const { accounts, state } = build(values);

      const waits = accounts.flatMap((account) => {
        const current = state[account.id];

        return account.enabled && current?.status === "cooling" ? [current.until - NOW] : [];
      });

      const expected = waits.length > 0 ? Option.some(Math.min(...waits)) : Option.none();
      expect(retryAfter(accounts, state, NOW)).toEqual(expected);
    },
  );

  /** Which built account (if any) to name as `preferred`, and whether to misspell its id. */
  const Preferred = Schema.Struct({
    index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
    missing: Schema.Boolean,
  });

  const preferredSpecs = Arbitrary.schema(Preferred);

  it.prop(
    "a preferred account is always chosen when it is available, whatever the fill order",
    { specs, preferred: preferredSpecs },
    ({ specs: values, preferred }) => {
      const { accounts, state } = build(values);
      const target = accounts[preferred.index % accounts.length];

      if (target === undefined || preferred.missing || !expectAvailable(state, NOW)(target)) {
        return true;
      }

      expect(select(accounts, state, NOW, Option.some(target.id))).toEqual(Option.some(target));

      return true;
    },
  );

  it.prop(
    "falls back to fill-first when the preferred account is unavailable or not in the list",
    { specs, preferred: preferredSpecs },
    ({ specs: values, preferred }) => {
      const { accounts, state } = build(values);
      const target = accounts[preferred.index % accounts.length];

      if (target === undefined) return true;
      const id = preferred.missing ? `${target.id}-missing` : target.id;

      if (!preferred.missing && expectAvailable(state, NOW)(target)) return true;
      expect(select(accounts, state, NOW, Option.some(id))).toEqual(select(accounts, state, NOW));

      return true;
    },
  );
});
