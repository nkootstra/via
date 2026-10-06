import { ownedFiles } from "@via/config";
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  type Stream,
  SubscriptionRef,
} from "effect";
import type { AccountState, PoolState } from "./select.ts";

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
    // Updates run one at a time, so each decides on the latest state and the file
    // never ends up with an older one. Only an update that changes something is published.
    const states = yield* SubscriptionRef.make(initial);

    /** Sets `id`'s state to what `next` makes of it, unless that is none; says whether it did. */
    const update = (
      id: string,
      next: (current: AccountState | undefined) => AccountState | undefined,
    ) =>
      SubscriptionRef.modifySomeEffect(states, (current) => {
        const state = next(current[id]);

        if (state === undefined) return Effect.succeed([false, Option.none()] as const);
        const updated = { ...current, [id]: state };

        return Effect.as(save(updated), [true, Option.some(updated)] as const);
      });

    return PoolStates.of({
      get: SubscriptionRef.get(states),
      changes: SubscriptionRef.changes(states),
      coolDown: (id, until, reason) =>
        update(id, (current) =>
          current?.status === "auth_error" ||
          (current?.status === "cooling" && current.until >= until)
            ? undefined
            : { status: "cooling", until, reason },
        ),
      lockOut: (id, reason) => Effect.asVoid(update(id, () => ({ status: "auth_error", reason }))),
      // Nothing to save: the file keeps only cooldowns, and this leaves them as they are.
      liftLockOut: (id) =>
        SubscriptionRef.modifySome(states, (current) => {
          if (current[id]?.status !== "auth_error") return [undefined, Option.none()] as const;
          const { [id]: _lifted, ...others } = current;

          return [undefined, Option.some(others)] as const;
        }),
    });
  });

/** Cooldowns and lockouts of the accounts, as learned from upstream answers. */
export class PoolStates extends Context.Service<
  PoolStates,
  {
    readonly get: Effect.Effect<PoolState>;
    /** The state now, then the state after every update that changes it. */
    readonly changes: Stream.Stream<PoolState>;
    /**
     * Takes the account out of rotation until `until`, unless it is locked out
     * or already cooling at least that long: a cooldown is never shortened.
     * Says whether it changed the account's state.
     */
    readonly coolDown: (id: string, until: number, reason: string) => Effect.Effect<boolean>;
    /** Takes the account out of rotation until it logs in again. */
    readonly lockOut: (id: string, reason: string) => Effect.Effect<void>;
    /**
     * Puts a locked-out account back in rotation, as a new login does. A cooldown
     * stays: it is a real usage limit, which a login does not lift.
     */
    readonly liftLockOut: (id: string) => Effect.Effect<void>;
  }
>()("via/PoolStates") {
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
        const files = yield* ownedFiles;

        const stored = yield* files
          .read(path, Cooldowns, () => ({}))
          .pipe(
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
            Effect.flatMap((at) => files.write(path, Cooldowns, running(state, at))),
            Effect.catchTag("PlatformError", (error) =>
              Effect.logWarning(`Could not save cooldowns: ${error.message}`),
            ),
          );

        return yield* make(initial, save);
      }),
    );
}
