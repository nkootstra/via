import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Arbitrary } from "effect/unstable/arbitrary";
import { PoolStates } from "./pool-states.ts";
import type { PoolState } from "./select.ts";

/** Runs `body` against the states kept in `path`, as one `via serve` process would. */
const run = <A, E>(path: string, body: (states: PoolStates["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* body(yield* PoolStates);
  }).pipe(Effect.provide(PoolStates.layerFile(path)));

layer(BunFileSystem.layer)("PoolStates", (it) => {
  it.effect("remembers what serve learned about each account", () =>
    Effect.gen(function* () {
      const states = yield* PoolStates;
      expect(yield* states.get).toEqual({});
      yield* states.coolDown("acc-a", 5, "usage_limit_reached");
      yield* states.lockOut("acc-b", "refresh_token_expired");
      expect(yield* states.get).toEqual({
        "acc-a": { status: "cooling", until: 5, reason: "usage_limit_reached" },
        "acc-b": { status: "auth_error", reason: "refresh_token_expired" },
      });
    }).pipe(Effect.provide(PoolStates.layer)),
  );

  it.effect("never shortens a running cooldown, and says so", () =>
    Effect.gen(function* () {
      const states = yield* PoolStates;
      expect(yield* states.coolDown("acc-a", 500, "usage_limit_reached")).toBe(true);
      expect(yield* states.coolDown("acc-a", 100, "server_error")).toBe(false);
      expect(yield* states.get).toEqual({
        "acc-a": { status: "cooling", until: 500, reason: "usage_limit_reached" },
      });
    }).pipe(Effect.provide(PoolStates.layer)),
  );

  it.effect("never lets a cooldown lift a lockout", () =>
    Effect.gen(function* () {
      const states = yield* PoolStates;
      yield* states.lockOut("acc-a", "invalid_grant");
      expect(yield* states.coolDown("acc-a", 500, "usage_limit_reached")).toBe(false);
      expect(yield* states.get).toEqual({
        "acc-a": { status: "auth_error", reason: "invalid_grant" },
      });
    }).pipe(Effect.provide(PoolStates.layer)),
  );

  it.effect("keeps a cooldown across a restart", () =>
    Effect.gen(function* () {
      const path = `${yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()}/state.json`;
      const cooling = { status: "cooling", until: 60_000, reason: "usage_limit_reached" } as const;
      yield* run(path, (states) => states.coolDown("acc-a", cooling.until, cooling.reason));
      expect(yield* run(path, (states) => states.get)).toEqual({ "acc-a": cooling });
    }),
  );

  it.effect("forgets lockouts and elapsed cooldowns on a restart", () =>
    Effect.gen(function* () {
      const path = `${yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()}/state.json`;
      yield* run(path, (states) =>
        Effect.gen(function* () {
          yield* states.coolDown("acc-a", 5, "server_error");
          yield* states.lockOut("acc-b", "refresh_token_expired");
        }),
      );
      yield* TestClock.adjust(10);
      expect(yield* run(path, (states) => states.get)).toEqual({});
    }),
  );

  it.effect("drops a persisted cooldown once the account is locked out", () =>
    Effect.gen(function* () {
      const path = `${yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()}/state.json`;
      yield* run(path, (states) =>
        Effect.gen(function* () {
          yield* states.coolDown("acc-a", 60_000, "server_error");
          yield* states.lockOut("acc-a", "account_deactivated");
        }),
      );
      expect(yield* run(path, (states) => states.get)).toEqual({});
    }),
  );

  it.effect("starts afresh from a corrupt state file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = `${yield* fs.makeTempDirectoryScoped()}/state.json`;
      yield* fs.writeFileString(path, "{not json");
      expect(yield* run(path, (states) => states.get)).toEqual({});
    }),
  );

  it.effect("keeps serving from memory when the state file cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const blocker = `${yield* fs.makeTempDirectoryScoped()}/not-a-directory`;
      yield* fs.writeFileString(blocker, "");
      const cooling = { status: "cooling", until: 60_000, reason: "usage_limit_reached" } as const;

      const seen = yield* run(`${blocker}/state.json`, (states) =>
        states.coolDown("acc-a", cooling.until, cooling.reason).pipe(Effect.andThen(states.get)),
      );

      expect(seen).toEqual({ "acc-a": cooling });
    }),
  );

  it.effect("saves every one of many concurrent marks", () =>
    Effect.gen(function* () {
      const path = `${yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()}/state.json`;
      const until = (yield* Clock.currentTimeMillis) + 60_000;
      const ids = Array.from({ length: 20 }, (_, i) => `acc-${i}`);

      yield* run(path, (states) =>
        Effect.forEach(ids, (id) => states.coolDown(id, until, "server_error"), {
          concurrency: "unbounded",
          discard: true,
        }),
      );

      expect(Object.keys(yield* run(path, (states) => states.get)).toSorted()).toEqual(
        ids.toSorted(),
      );
    }),
  );

  /** One account's fate before a restart: absent, cooling by a fixed offset, or locked out. */
  const Spec = Schema.Struct({
    kind: Schema.Literals(["none", "cooling", "auth_error"]),
    offsetMs: Schema.Int.check(Schema.isBetween({ minimum: -5_000, maximum: 5_000 })),
    reason: Schema.Literals(["quota", "server_error", "invalid_grant"]),
  });

  const specs = Arbitrary.array(Arbitrary.schema(Spec), { minLength: 1, maxLength: 5 });

  it.effect.prop(
    "a restart keeps only cooldowns still running, never a lockout",
    { specs },
    ({ specs: values }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = `${yield* fs.makeTempDirectoryScoped()}/state.json`;
        // The suite's TestClock is shared across tests, so read its current time
        // rather than assuming a fresh 0 — only the sign of each offset matters.
        const now = yield* Clock.currentTimeMillis;
        yield* run(path, (states) =>
          Effect.forEach(
            values,
            (spec, i) => {
              const id = `acc-${i}`;

              if (spec.kind === "cooling") {
                return states.coolDown(id, now + spec.offsetMs, spec.reason);
              }

              if (spec.kind === "auth_error") {
                return states.lockOut(id, spec.reason);
              }

              return Effect.void;
            },
            { discard: true },
          ),
        );
        const restarted = yield* run(path, (states) => states.get);

        const expected: PoolState = Object.fromEntries(
          values.flatMap((spec, i) =>
            spec.kind === "cooling" && spec.offsetMs > 0
              ? [
                  [
                    `acc-${i}`,
                    { status: "cooling" as const, until: now + spec.offsetMs, reason: spec.reason },
                  ],
                ]
              : [],
          ),
        );

        expect(restarted).toEqual(expected);
      }),
    // Each run writes and reads files; fewer runs cover five accounts' kinds plenty,
    // and the timeout leaves room for a loaded machine.
    { timeout: 30_000, arbitrary: { runs: 25 } },
  );

  /** One write to an account's state: a cooldown until `until` for `reason`, or a lockout. */
  const Mark = Schema.Struct({
    kind: Schema.Literals(["cooling", "auth_error"]),
    // A narrow range, so marks often tie with the running cooldown.
    until: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
    reason: Schema.Literals(["usage_limit_reached", "server_error"]),
  });

  const marks = Arbitrary.array(Arbitrary.schema(Mark), { minLength: 1, maxLength: 8 });

  it.effect.prop(
    "coolDown only lengthens a cooldown, never touches a lockout, and says whether it changed",
    { marks },
    ({ marks: values }) =>
      Effect.gen(function* () {
        const states = yield* PoolStates;

        for (const mark of values) {
          if (mark.kind === "auth_error") {
            yield* states.lockOut("acc-a", "invalid_grant");
            continue;
          }

          const before = (yield* states.get)["acc-a"];

          const lengthens =
            before === undefined || (before.status === "cooling" && before.until < mark.until);

          expect(yield* states.coolDown("acc-a", mark.until, mark.reason)).toBe(lengthens);

          expect((yield* states.get)["acc-a"]).toEqual(
            lengthens ? { status: "cooling", until: mark.until, reason: mark.reason } : before,
          );
        }
      }).pipe(Effect.provide(PoolStates.layer)),
  );

  /** One write to an account's state: a cooldown until `until`, or a lockout. */
  const Write = Schema.Struct({
    kind: Schema.Literals(["cooling", "auth_error"]),
    until: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 })),
  });

  const writes = Arbitrary.array(Arbitrary.schema(Write), { minLength: 1, maxLength: 8 });

  it.effect.prop(
    "however concurrent writes interleave, a lockout sticks and the longest cooldown wins",
    { writes },
    ({ writes: values }) =>
      Effect.gen(function* () {
        const states = yield* PoolStates;
        yield* Effect.forEach(
          values,
          (write) =>
            write.kind === "cooling"
              ? states.coolDown("acc-a", write.until, "server_error")
              : states.lockOut("acc-a", "invalid_grant"),
          { concurrency: "unbounded", discard: true },
        );

        const state = (yield* states.get)["acc-a"];

        if (values.some((write) => write.kind === "auth_error")) {
          expect(state?.status).toBe("auth_error");
        } else {
          expect(state).toMatchObject({
            status: "cooling",
            until: Math.max(...values.map((write) => write.until)),
          });
        }
      }).pipe(Effect.provide(PoolStates.layer)),
  );
});
