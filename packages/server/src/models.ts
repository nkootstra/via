import { CodexUpstream, modelIds } from "@via/codex-upstream";
import { Providers } from "@via/providers";
import { Cache, Context, Effect, Exit, Layer } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { authenticated, nextAccount } from "./dispatch.ts";

/** The models `/v1/models` lists, with who offers them. */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  Effect.Effect<ReadonlyArray<{ id: string; ownedBy: string }>>
>()("via/ModelCatalog") {
  /**
   * Lists the models Codex offers the account the pool would pick next, as
   * the Codex picker does, then every provider's, and keeps each list for five
   * minutes. When Codex can't be asked, it lists the models via bundles.
   */
  static readonly layer = Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const codex = yield* CodexUpstream;
      const providerModels = yield* Effect.cachedWithTTL((yield* Providers).models, "5 minutes");
      const ask = nextAccount.pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.flatMap((account) => codex.models(account)),
      );
      const cache = yield* Cache.makeWith(() => ask, {
        capacity: 1,
        // A failed ask is not kept, so the next request tries Codex again.
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
      });
      const codexModels = Cache.get(cache, undefined).pipe(
        Effect.map(modelIds),
        // Any failure to ask Codex leaves the bundled list, which is still a useful answer.
        Effect.orElseSucceed(() => modelIds()),
        Effect.map((ids) => ids.map((id) => ({ id, ownedBy: "openai" }))),
      );
      return Effect.all([codexModels, providerModels], { concurrency: "unbounded" }).pipe(
        Effect.map(([fromCodex, fromProviders]) => [
          ...fromCodex,
          ...fromProviders.map(({ id, provider }) => ({ id, ownedBy: provider })),
        ]),
      );
    }),
  );
}

/** GET /v1/models: the Codex models, each with every effort suffix, then the providers'. */
export const models = authenticated(
  Effect.gen(function* () {
    const catalog = yield* yield* ModelCatalog;
    return HttpServerResponse.jsonUnsafe({
      object: "list",
      data: catalog.map(({ id, ownedBy }) => ({
        id,
        object: "model",
        created: 0,
        owned_by: ownedBy,
      })),
    });
  }),
);
