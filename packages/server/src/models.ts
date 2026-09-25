import { AccountStore, AccountTokens } from "@via/codex-auth";
import { CodexUpstream, modelIds } from "@via/codex-upstream";
import { PoolStates, select } from "@via/pool";
import { Cache, Clock, Context, Effect, Exit, Layer, Option } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { authenticated } from "./dispatch.ts";

/** The model ids `/v1/models` lists. */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  Effect.Effect<ReadonlyArray<string>>
>()("via/ModelCatalog") {
  /**
   * Lists the models Codex offers the account the pool would pick next, as
   * the Codex picker does, and keeps the list for five minutes. When Codex
   * can't be asked, it lists the models via bundles.
   */
  static readonly layer = Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const store = yield* AccountStore;
      const tokens = yield* AccountTokens;
      const codex = yield* CodexUpstream;
      const states = yield* PoolStates;
      const ask = Effect.gen(function* () {
        while (true) {
          const chosen = select(
            yield* store.list,
            yield* states.get,
            yield* Clock.currentTimeMillis,
          );
          const account = yield* Effect.fromOption(chosen);
          const fresh = yield* tokens.fresh(account).pipe(
            Effect.asSome,
            Effect.catchTag("RefreshRejectedError", (error) =>
              states
                .lockOut(account.id, error.code)
                .pipe(Effect.as(Option.none())),
            ),
          );
          if (Option.isSome(fresh)) return yield* codex.models(fresh.value);
        }
      });
      const cache = yield* Cache.makeWith(() => ask, {
        capacity: 1,
        // A failed ask is not kept, so the next request tries Codex again.
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
      });
      return Cache.get(cache, undefined).pipe(
        Effect.map(modelIds),
        // Any failure to ask Codex leaves the bundled list, which is still a useful answer.
        Effect.orElseSucceed(() => modelIds()),
      );
    }),
  );
}

/** GET /v1/models: the Codex models, and each with every effort suffix. */
export const models = authenticated(
  Effect.gen(function* () {
    const ids = yield* yield* ModelCatalog;
    return HttpServerResponse.jsonUnsafe({
      object: "list",
      data: ids.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "openai",
      })),
    });
  }),
);
