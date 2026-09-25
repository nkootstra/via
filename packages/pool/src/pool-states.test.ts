import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { PoolStates, type PoolStatesShape } from "./pool-states.ts";

/** Runs `body` against the states kept in `path`, as one `via serve` process would. */
const run = <A, E>(path: string, body: (states: PoolStatesShape) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* body(yield* PoolStates);
  }).pipe(Effect.provide(PoolStates.layerFile(path)));

layer(BunFileSystem.layer)("PoolStates", (it) => {
  it.effect("remembers what serve learned about each account", () =>
    Effect.gen(function* () {
      const states = yield* PoolStates;
      expect(yield* states.get).toEqual({});
      yield* states.mark("acc-a", {
        status: "cooling",
        until: 5,
        reason: "usage_limit_reached",
      });
      yield* states.lockOut("acc-b", "refresh_token_expired");
      expect(yield* states.get).toEqual({
        "acc-a": { status: "cooling", until: 5, reason: "usage_limit_reached" },
        "acc-b": { status: "auth_error", reason: "refresh_token_expired" },
      });
    }).pipe(Effect.provide(PoolStates.layer)),
  );

  it.effect("keeps a cooldown across a restart", () =>
    Effect.gen(function* () {
      const path = `${yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()}/state.json`;
      const cooling = { status: "cooling", until: 60_000, reason: "usage_limit_reached" } as const;
      yield* run(path, (states) => states.mark("acc-a", cooling));
      expect(yield* run(path, (states) => states.get)).toEqual({ "acc-a": cooling });
    }),
  );

  it.effect("forgets lockouts and elapsed cooldowns on a restart", () =>
    Effect.gen(function* () {
      const path = `${yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()}/state.json`;
      yield* run(path, (states) =>
        Effect.gen(function* () {
          yield* states.mark("acc-a", { status: "cooling", until: 5, reason: "server_error" });
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
          yield* states.mark("acc-a", { status: "cooling", until: 60_000, reason: "server_error" });
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
});
