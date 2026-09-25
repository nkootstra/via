import { type CatalogModel, CodexUpstream, modelIds } from "@via/codex-upstream";
import { type ProviderModel, Providers } from "@via/providers";
import { Array, Clock, Context, Duration, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { authenticated, usableAccounts } from "./dispatch.ts";

/** A model object with only what via knows about the model. */
const entry = (id: string, ownedBy: string) => ({
  id,
  object: "model",
  created: 0,
  owned_by: ownedBy,
});

/** One catalog of every model in `catalogs`, each with every effort any of them supports. */
const combine = (catalogs: ReadonlyArray<ReadonlyArray<CatalogModel>>) => {
  const efforts = new Map<string, ReadonlyArray<string>>();
  for (const { model, efforts: more } of catalogs.flat()) {
    efforts.set(model, Array.union(efforts.get(model) ?? [], more));
  }
  return [...efforts].map(([model, supported]) => ({ model, efforts: supported }));
};

const isOld = (at: number, maxAge: Duration.Input) =>
  Effect.map(Clock.currentTimeMillis, (now) => now - at >= Duration.toMillis(maxAge));

/**
 * Keeps `load`'s last success. Only the first call waits for `load`; once what
 * it keeps is `maxAge` old, a call starts one reload in the background and
 * still answers with what it keeps, so the next call gets the new answer.
 */
const stale = <A, E, R>(load: Effect.Effect<A, E, R>, maxAge: Duration.Input) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const lock = yield* Semaphore.make(1);
    const kept = yield* Ref.make(Option.none<{ readonly value: A; readonly at: number }>());
    const reload = Effect.gen(function* () {
      const value = yield* load;
      yield* Ref.set(kept, Option.some({ value, at: yield* Clock.currentTimeMillis }));
      return value;
    }).pipe(Effect.provide(context));
    // Run under the lock: what another call has just loaded, or else a new load.
    const loadIfOld = Effect.gen(function* () {
      const current = yield* Ref.get(kept);
      if (Option.isSome(current) && !(yield* isOld(current.value.at, maxAge)))
        return current.value.value;
      return yield* reload;
    });
    return Effect.gen(function* () {
      const current = yield* Ref.get(kept);
      // Calls that find nothing kept wait for one shared load.
      if (Option.isNone(current)) return yield* Semaphore.withPermits(lock, 1)(loadIfOld);
      if (yield* isOld(current.value.at, maxAge)) {
        // One reload at a time; a failed one keeps the old answer, and a later call tries again.
        yield* Semaphore.withPermitsIfAvailable(
          lock,
          1,
        )(loadIfOld).pipe(Effect.ignore, Effect.forkIn(scope));
      }
      return current.value.value;
    });
  });

/** The models `/v1/models` lists, in OpenAI's model object shape. */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  Effect.Effect<ReadonlyArray<ProviderModel>>
>()("via/ModelCatalog") {
  /**
   * Lists the models Codex offers any usable account, as the Codex picker
   * does, since plans differ, then every provider's as the provider describes
   * them. Both are fetched as via starts and refreshed in the background
   * once five minutes old. When no account can ask Codex, it lists the models via bundles.
   */
  static readonly layer = Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const codex = yield* CodexUpstream;
      const providerModels = yield* stale((yield* Providers).models, "5 minutes");
      const ask = usableAccounts.pipe(
        Effect.flatMap((accounts) =>
          Effect.forEach(accounts, (account) => Effect.option(codex.models(account)), {
            concurrency: "unbounded",
          }),
        ),
        Effect.map(Array.getSomes),
        // Failing when no account answered keeps the bundled list from being kept.
        Effect.flatMap((catalogs) =>
          Effect.fromOption(
            Array.isReadonlyArrayNonEmpty(catalogs)
              ? Option.some(combine(catalogs))
              : Option.none(),
          ),
        ),
      );
      const codexModels = (yield* stale(ask, "5 minutes")).pipe(
        Effect.map(modelIds),
        // Any failure to ask Codex leaves the bundled list, which is still a useful answer.
        Effect.orElseSucceed(() => modelIds()),
        Effect.map((ids) => ids.map((id) => entry(id, "openai"))),
      );
      const catalog = Effect.all([codexModels, providerModels], { concurrency: "unbounded" }).pipe(
        Effect.map(([fromCodex, fromProviders]) => [
          ...fromCodex,
          // The provider's own fields, such as context_length or pricing, win.
          ...fromProviders.map(({ provider, model }) => ({
            ...entry(model.id, provider),
            ...model,
          })),
        ]),
      );
      // Fetched as via starts, so the first request need not wait.
      yield* Effect.forkScoped(catalog);
      return catalog;
    }),
  );
}

/** GET /v1/models: the Codex models, each with every effort suffix, then the providers'. */
export const models = authenticated(
  Effect.gen(function* () {
    return HttpServerResponse.jsonUnsafe({ object: "list", data: yield* yield* ModelCatalog });
  }),
);
