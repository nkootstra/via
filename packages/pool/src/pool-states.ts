import { Context, Effect, Layer, Ref } from "effect";
import type { AccountState, PoolState } from "./select.ts";

export interface PoolStatesShape {
  readonly get: Effect.Effect<PoolState>;
  readonly mark: (id: string, state: AccountState) => Effect.Effect<void>;
  /** Takes the account out of rotation until it logs in again. */
  readonly lockOut: (id: string, reason: string) => Effect.Effect<void>;
}

/** Cooldowns and lockouts of the accounts, as learned from upstream answers. */
export class PoolStates extends Context.Service<PoolStates, PoolStatesShape>()("via/PoolStates") {
  static readonly layer = Layer.effect(
    PoolStates,
    Effect.gen(function* () {
      const states = yield* Ref.make<PoolState>({});
      const mark = (id: string, state: AccountState) =>
        Ref.update(states, (current) => ({ ...current, [id]: state }));
      return PoolStates.of({
        get: Ref.get(states),
        mark,
        lockOut: (id, reason) => mark(id, { status: "auth_error", reason }),
      });
    }),
  );
}
