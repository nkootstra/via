import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { type Failures, type Limits, SIGN_IN_LIMITS, attempt } from "./sign-in-throttle.ts";

/** Small limits, so a few dozen sign-ins reach them. */
const limits: Limits = { perClient: 3, total: 8, window: 100 };

describe("sign-in throttle", () => {
  it("throttles a client after its own failures, and not the others", () => {
    let failures: Failures = new Map();

    for (let at = 0; at < 3; at++) {
      const [outcome, next] = attempt(limits, failures, { client: "a", now: at, matches: false });
      expect(outcome).toBe("wrong");
      failures = next;
    }

    expect(attempt(limits, failures, { client: "a", now: 3, matches: true })[0]).toBe("throttled");
    expect(attempt(limits, failures, { client: "b", now: 3, matches: true })[0]).toBe("ok");
    // The window is 100 ms: at 100, the failure at 0 has dropped out.
    expect(attempt(limits, failures, { client: "a", now: 100, matches: true })[0]).toBe("ok");
  });

  it("clears only the signed-in client's failures", () => {
    const failures: Failures = new Map([
      ["a", [0, 1]],
      ["b", [0, 1]],
    ]);

    const [outcome, next] = attempt(limits, failures, { client: "a", now: 2, matches: true });
    expect(outcome).toBe("ok");
    expect(next).toEqual(new Map([["b", [0, 1]]]));
  });

  it("throttles everyone once the failures of all clients reach the backstop", () => {
    const failures: Failures = new Map(
      Array.from({ length: 4 }, (_, client) => [`${client}`, [0, 1]] as const),
    );

    expect(attempt(limits, failures, { client: "new", now: 2, matches: true })[0]).toBe(
      "throttled",
    );
  });

  it("takes many clients to reach the backstop, not one client's worth", () => {
    expect(SIGN_IN_LIMITS.total).toBeGreaterThanOrEqual(100 * SIGN_IN_LIMITS.perClient);
  });

  /** A sign-in: from which of a dozen clients, how long after the last, and with the right key or not. */
  const Attempt = Schema.Struct({
    client: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
    gap: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40 })),
    matches: Schema.Boolean,
  });

  const attempts = Arbitrary.array(Arbitrary.schema(Attempt), { minLength: 1, maxLength: 120 });

  it.prop(
    "a client is refused only for its own failures or the backstop, and the buckets stay bounded",
    { attempts },
    ({ attempts: values }) => {
      let failures: Failures = new Map();
      // Every failure still counted, as a log: a sign-in drops its client's.
      let log: ReadonlyArray<{ readonly client: string; readonly at: number }> = [];
      let now = 0;

      for (const { client: index, gap, matches } of values) {
        now += gap;
        const client = `${index}`;
        log = log.filter(({ at }) => now - at < limits.window);
        const own = log.filter((failure) => failure.client === client).length;

        const expected =
          own >= limits.perClient || log.length >= limits.total
            ? "throttled"
            : matches
              ? "ok"
              : "wrong";

        const [outcome, next] = attempt(limits, failures, { client, now, matches });
        expect(outcome).toBe(expected);
        failures = next;

        if (outcome === "ok") log = log.filter((failure) => failure.client !== client);

        if (outcome === "wrong") log = [...log, { client, at: now }];

        const counted = [...failures.values()];
        expect(failures.size).toBeLessThanOrEqual(limits.total);
        expect(counted.flat().length).toBeLessThanOrEqual(limits.total);

        for (const times of counted) {
          expect(times.length).toBeGreaterThan(0);
          expect(times.length).toBeLessThanOrEqual(limits.perClient);
        }
      }
    },
  );
});
