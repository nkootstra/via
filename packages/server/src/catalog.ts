import { type CatalogModel, CodexUpstream, modelIds, resolveAlias } from "@via/codex-upstream";
import { OpencodeGoAccounts, type ProviderModel, Providers } from "@via/providers";
import { Array, Clock, Context, Duration, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { AccountPool } from "@via/account-pool";
import type { Account } from "@via/codex-auth";

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

/** Ids, in order, as one string: two lists of the same accounts make the same key. */
const keyOf = (ids: ReadonlyArray<string>) => ids.join("\n");

/** How long a failed load is remembered, so calls meanwhile fail at once instead of loading again. */
const FAILURE_KEPT = Duration.minutes(1);

/**
 * Keeps `load(input)`'s last success, for the `key` of the input it loaded.
 * A call with an input of another key, such as when the accounts that serve
 * changed, waits for a load of its own, as does the first; once what it keeps
 * is `maxAge` old, a call starts one reload in the background and still
 * answers with what it keeps, so the next call gets the new answer. A failed
 * load is remembered for a minute, with a warning that names `what` failed:
 * meanwhile a call with nothing kept fails with it at once, and one with an
 * old answer starts no reload.
 */
const stale = <I, A, E, R>(
  what: string,
  load: (input: I) => Effect.Effect<A, E, R>,
  key: (input: I) => string,
  maxAge: Duration.Input,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const lock = yield* Semaphore.make(1);

    const kept = yield* Ref.make(
      Option.none<{ readonly key: string; readonly value: A; readonly at: number }>(),
    );

    const failed = yield* Ref.make(
      Option.none<{ readonly key: string; readonly error: E; readonly at: number }>(),
    );

    const reload = (input: I) =>
      Effect.gen(function* () {
        const value = yield* load(input).pipe(
          Effect.tapError((error) =>
            Effect.flatMap(Clock.currentTimeMillis, (at) =>
              Ref.set(failed, Option.some({ key: key(input), error, at })),
            ).pipe(
              Effect.andThen(
                Effect.logWarning(
                  `Could not load ${what}; trying again in a minute at the earliest`,
                ),
              ),
            ),
          ),
        );
        const at = yield* Clock.currentTimeMillis;
        yield* Ref.set(kept, Option.some({ key: key(input), value, at }));
        yield* Ref.set(failed, Option.none());

        return value;
      }).pipe(Effect.provide(context));

    /** The error a load for `input` failed with less than a minute ago, if one did. */
    const failedRecently = (input: I) =>
      Effect.gen(function* () {
        const last = Option.filter(yield* Ref.get(failed), (failure) => failure.key === key(input));

        if (Option.isNone(last) || (yield* isOld(last.value.at, FAILURE_KEPT))) {
          return Option.none<E>();
        }

        return Option.some(last.value.error);
      });

    /** What is kept for `input`, if anything is. */
    const keptFor = (input: I) =>
      Effect.map(
        Ref.get(kept),
        Option.filter((current) => current.key === key(input)),
      );

    // Run under the lock: what another call has just loaded, or else a new load.
    const loadIfOld = (input: I) =>
      Effect.gen(function* () {
        const current = yield* keptFor(input);

        if (Option.isSome(current) && !(yield* isOld(current.value.at, maxAge)))
          return current.value.value;

        // Calls that queued behind a load that failed fail with it rather than loading again.
        const failure = yield* failedRecently(input);

        if (Option.isSome(failure)) return yield* Effect.fail(failure.value);

        return yield* reload(input);
      });

    // The reader itself, not what it reads: each call runs it anew.
    return (input: I) =>
      Effect.gen(function* () {
        const current = yield* keptFor(input);

        // Calls that find nothing kept for their input wait for one shared load.
        if (Option.isNone(current)) return yield* Semaphore.withPermits(lock, 1)(loadIfOld(input));

        if (
          (yield* isOld(current.value.at, maxAge)) &&
          Option.isNone(yield* failedRecently(input))
        ) {
          // One reload at a time; a failed one keeps the old answer, and a later call tries again.
          yield* Semaphore.withPermitsIfAvailable(
            lock,
            1,
          )(loadIfOld(input)).pipe(Effect.ignore, Effect.forkIn(scope));
        }

        return current.value.value;
      });
  });

/** The models one account's plan offers. */
interface Offered {
  readonly accountId: string;
  readonly catalog: ReadonlyArray<CatalogModel>;
}

/**
 * Whether an account may serve `model`: any account when no catalog lists it,
 * as a new model may not be listed yet, and otherwise the accounts that list it
 * or whose catalog via does not know.
 */
const mayServe = (offered: ReadonlyArray<Offered>, model: string) => {
  const base = resolveAlias(model).model;
  const known = new Set(offered.map(({ accountId }) => accountId));

  const offering = new Set(
    offered
      .values()
      .filter(({ catalog }) => catalog.some((listed) => listed.model === base))
      .map(({ accountId }) => accountId),
  );

  return (accountId: string) =>
    offering.size === 0 || offering.has(accountId) || !known.has(accountId);
};

/** The models via serves: what `/v1/models` lists, and which accounts offer a model. */
export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /** The models `/v1/models` lists, in OpenAI's model object shape. */
    readonly list: Effect.Effect<ReadonlyArray<ProviderModel>>;
    /** Which accounts may serve `model`, by account id. */
    readonly mayServe: (model: string) => Effect.Effect<(accountId: string) => boolean>;
  }
>()("via/ModelCatalog") {
  /**
   * Lists the models Codex offers the accounts that serve, as the Codex picker
   * does, since plans differ, then every provider's as the provider describes
   * them. An account serves while it is enabled and not locked out; one
   * cooling down still counts, as it serves again once its cooldown ends, but
   * a locked-out one only serves after it signs in again. OpenCode Go's models
   * are asked with one of its enabled accounts.
   *
   * Both are fetched as via starts and refreshed in the background once five
   * minutes old, and fetched again at once when the accounts that serve change,
   * so a disabled account's models go as soon as it is disabled. With no account
   * serving, no Codex models are listed; when accounts serve but none can ask
   * Codex, it lists the models via bundles.
   */
  static readonly layer = Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const codex = yield* CodexUpstream;
      const pool = yield* AccountPool;
      const providers = yield* Providers;
      const opencodeGo = yield* OpencodeGoAccounts;

      const providerModels = yield* stale(
        "the providers' models",
        () => providers.models,
        keyOf,
        "5 minutes",
      );

      /** The enabled OpenCode Go accounts, by id: the keys its models can be asked with. */
      const enabledOpencodeGo = opencodeGo.list.pipe(
        Effect.map((all) => all.filter(({ enabled }) => enabled).map(({ id }) => id)),
        // A store via can't read has no key to lend, as Providers finds too.
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

      /** The OpenRouter models the web UI enabled; none when config.yaml sets it up. */
      const enabledOpenrouter = Effect.map(providers.openrouter.get, (saved) =>
        Option.match(saved, {
          onNone: (): ReadonlyArray<string> => [],
          onSome: ({ models }) => models,
        }),
      );

      /**
       * What the providers' models depend on: the OpenCode Go accounts that can ask,
       * the providers, as an Ollama may be added or removed while via runs, and the
       * OpenRouter models enabled, which change there too.
       */
      const providersToAsk = Effect.all([
        enabledOpencodeGo,
        providers.names,
        enabledOpenrouter,
      ]).pipe(
        Effect.flatMap(([ids, names, openrouter]) =>
          providerModels([
            ...ids,
            ...names.map((name) => `provider:${name}`),
            ...openrouter.map((model) => `openrouter:${model}`),
          ]),
        ),
      );

      const ask = (accounts: ReadonlyArray<Account>) =>
        Effect.forEach(
          accounts,
          (account) =>
            pool.withFreshToken(account).pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.flatMap((fresh) => codex.models(fresh)),
              Effect.map((catalog) => ({ accountId: account.id, catalog })),
              Effect.option,
            ),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(Array.getSomes),
          // Failing when no account answered keeps the bundled list from being kept.
          Effect.filterOrFail(Array.isReadonlyArrayNonEmpty),
        );

      const offeredTo = yield* stale(
        "the models Codex offers",
        ask,
        (accounts) => keyOf(accounts.map(({ id }) => id)),
        "5 minutes",
      );

      /** What Codex offers each account that serves; none when no account serves. */
      const offered = pool.serving.pipe(
        Effect.flatMap((accounts) =>
          Array.isReadonlyArrayNonEmpty(accounts)
            ? Effect.asSome(offeredTo(accounts))
            : Effect.succeedNone,
        ),
      );

      const codexModels = offered.pipe(
        Effect.map(
          Option.match({
            // Nothing serves Codex, so nothing of Codex's is listed.
            onNone: () => [],
            onSome: (all) => modelIds(combine(all.map(({ catalog }) => catalog))),
          }),
        ),
        // Any failure to ask Codex leaves the bundled list, which is still a useful answer.
        Effect.orElseSucceed(() => modelIds()),
        Effect.map((ids) => ids.map((id) => entry(id, "openai"))),
      );

      const catalog = Effect.all([codexModels, providersToAsk], {
        concurrency: "unbounded",
      }).pipe(
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

      return {
        list: catalog,
        mayServe: (model) =>
          offered.pipe(
            Effect.map(Option.getOrElse((): ReadonlyArray<Offered> => [])),
            Effect.orElseSucceed((): ReadonlyArray<Offered> => []),
            Effect.map((all) => mayServe(all, model)),
          ),
      };
    }),
  );
}
