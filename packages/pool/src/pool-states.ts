import { readJsonFile, writeJsonFile } from "@via/config";
import { Clock, Context, Effect, FileSystem, Layer, Ref, Schema, Semaphore } from "effect";
import type { AccountState, PoolState } from "./select.ts";

export interface PoolStatesShape {
  readonly get: Effect.Effect<PoolState>;
  readonly mark: (id: string, state: AccountState) => Effect.Effect<void>;
  /** Takes the account out of rotation until it logs in again. */
  readonly lockOut: (id: string, reason: string) => Effect.Effect<void>;
}

/** The cooldowns still running, by account id: what outlives a restart. */
const Cooldowns = Schema.Record(
  Schema.String,
  Schema.Struct({ until: Schema.Finite, reason: Schema.String }),
);

const running = (state: PoolState, now: number): typeof Cooldowns.Type =>
  Object.fromEntries(
    Object.entries(state).flatMap(([id, current]) =>
      current.status === "cooling" && current.until > now
        ? [[id, { until: current.until, reason: current.reason }]]
        : [],
    ),
  );

const make = (initial: PoolState, save: (state: PoolState) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const states = yield* Ref.make(initial);
    // Saves run one at a time, so the file never ends up with an older state.
    const lock = yield* Semaphore.make(1);
    const mark = (id: string, state: AccountState) =>
      Ref.updateAndGet(states, (current) => ({ ...current, [id]: state })).pipe(
        Effect.flatMap(save),
        Semaphore.withPermit(lock),
      );
    return PoolStates.of({
      get: Ref.get(states),
      mark,
      lockOut: (id, reason) => mark(id, { status: "auth_error", reason }),
    });
  });

/** Cooldowns and lockouts of the accounts, as learned from upstream answers. */
export class PoolStates extends Context.Service<PoolStates, PoolStatesShape>()("via/PoolStates") {
  /** Kept in memory only. */
  static readonly layer = Layer.effect(
    PoolStates,
    make({}, () => Effect.void),
  );

  /**
   * Keeps running cooldowns in `path`, so a restarted `via serve` does not send
   * an account straight back into a limit. Lockouts stay in memory: a restart
   * gives a locked-out account one more try, and a new login fixes it anyway.
   * The file is a cache, so a corrupt or unwritable one is only logged.
   */
  static readonly layerFile = (path: string) =>
    Layer.effect(
      PoolStates,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stored = yield* readJsonFile(path, Cooldowns, () => ({})).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Ignoring saved cooldowns: ${error.message}`).pipe(Effect.as({})),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        const initial: PoolState = Object.fromEntries(
          Object.entries(stored)
            .filter(([, cooldown]) => cooldown.until > now)
            .map(([id, cooldown]) => [id, { status: "cooling", ...cooldown }]),
        );
        const save = (state: PoolState) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) => writeJsonFile(path, Cooldowns, running(state, at))),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.catchTag("PlatformError", (error) =>
              Effect.logWarning(`Could not save cooldowns: ${error.message}`),
            ),
          );
        return yield* make(initial, save);
      }),
    );
}
