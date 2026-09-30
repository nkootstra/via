import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import type { ProviderConfig } from "@via/config";
import { Effect, Exit, FileSystem, Layer, Option, Redacted, type Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  OpenrouterKeyRejectedError,
  OpenrouterNotEditableError,
  OpenrouterNotSetUpError,
} from "./errors.ts";
import { OpencodeGoAccounts, OpenrouterSettings, Providers } from "./index.ts";
import { type FakeProvider, startFakeProvider } from "./testing/index.ts";

const key = Redacted.make("sk-or-v1-abcd");

/** Providers set up by `configs` and `apiKeys`, with an OpenRouter settings file. */
const withOpenrouter = <A, E>(
  configs: Record<string, ProviderConfig>,
  body: (
    providers: Providers["Service"],
  ) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
  apiKeys: Record<string, Redacted.Redacted<string>> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();

    return yield* Effect.flatMap(Providers, body).pipe(
      Effect.provide(
        Providers.layer({ providers: configs, apiKeys, version: "1.2.3" }).pipe(
          Layer.provide([
            FetchHttpClient.layer,
            OpencodeGoAccounts.layer(`${dir}/go.json`),
            OpenrouterSettings.layer(`${dir}/openrouter.json`),
          ]),
        ),
      ),
    );
  });

/** OpenRouter as the fake plays it, taking `key`, with three models. */
const openrouter = (fake: FakeProvider) => {
  fake.openrouterKey(Redacted.value(key), { label: "sk-or-v1-abc...", usage: 1.5, limit: null });
  fake.models(["openai/gpt-6", "anthropic/claude-5", "google/gemini-4"]);

  return { openrouter: { baseUrl: fake.url } };
};

layer(BunFileSystem.layer)("Providers' OpenRouter", (it) => {
  it.effect("takes a key OpenRouter accepts, and offers only the models it enables", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;

      yield* withOpenrouter(openrouter(fake), (providers) =>
        Effect.gen(function* () {
          expect(yield* providers.openrouter.get).toEqual(Option.none());

          yield* providers.openrouter.setKey(key);
          expect(yield* providers.openrouter.get).toEqual(
            Option.some({ key: "…abcd", models: [], fromConfig: false }),
          );
          expect(fake.requests).toEqual([]);
          expect((yield* providers.models).map(({ model }) => model.id)).toEqual([]);

          yield* providers.openrouter.setModels(["openai/gpt-6", "google/gemini-4"]);

          expect((yield* providers.models).map(({ model }) => model.id)).toEqual([
            "openrouter/openai/gpt-6",
            "openrouter/google/gemini-4",
          ]);
          expect(providers.route("openrouter/openai/gpt-6")).toEqual(
            Option.some({ provider: "openrouter", model: "openai/gpt-6", pooled: false }),
          );
          expect(providers.route("openrouter/anthropic/claude-5")).toEqual(
            Option.some({
              provider: "openrouter",
              model: "anthropic/claude-5",
              pooled: false,
              disabled: true,
            }),
          );
        }),
      );
    }),
  );

  it.effect("lists every model OpenRouter has, to pick from", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;

      yield* withOpenrouter(openrouter(fake), (providers) =>
        Effect.gen(function* () {
          yield* providers.openrouter.setKey(key);

          expect((yield* providers.openrouter.catalog).map(({ id }) => id)).toEqual([
            "openai/gpt-6",
            "anthropic/claude-5",
            "google/gemini-4",
          ]);
        }),
      );
    }),
  );

  it.effect("refuses a key OpenRouter refuses, and keeps none", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;

      yield* withOpenrouter(openrouter(fake), (providers) =>
        Effect.gen(function* () {
          const set = yield* Effect.exit(providers.openrouter.setKey(Redacted.make("sk-wrong")));

          expect(set).toEqual(Exit.fail(new OpenrouterKeyRejectedError({ status: 401 })));
          expect(yield* providers.openrouter.get).toEqual(Option.none());
        }),
      );
    }),
  );

  it.effect("asks for a key before models can be enabled", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;

      yield* withOpenrouter(openrouter(fake), (providers) =>
        Effect.gen(function* () {
          const set = yield* Effect.exit(providers.openrouter.setModels(["openai/gpt-6"]));

          expect(set).toEqual(Exit.fail(new OpenrouterNotSetUpError()));
        }),
      );
    }),
  );

  it.effect("reads the key's budget from OpenRouter, and has none without a key", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      const configs = openrouter(fake);
      fake.openrouterKey(Redacted.value(key), {
        limit: 10,
        limit_remaining: 6.8,
        limit_reset: "monthly",
      });

      yield* withOpenrouter(configs, (providers) =>
        Effect.gen(function* () {
          expect(yield* providers.openrouter.budget).toEqual(Option.none());

          yield* providers.openrouter.setKey(key);

          // The test clock starts at the epoch: the next month starts on 1 February 1970.
          expect(yield* providers.openrouter.budget).toEqual(
            Option.some({
              budget: {
                limitUsd: 10,
                spentUsd: 3.2,
                window: "monthly",
                resetsAt: "1970-02-01T00:00:00.000Z",
              },
            }),
          );
        }),
      );
    }),
  );

  it.effect("says why the budget couldn't be read, rather than fail", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      const configs = openrouter(fake);

      yield* withOpenrouter(configs, (providers) =>
        Effect.gen(function* () {
          yield* providers.openrouter.setKey(key);
          fake.openrouterKey(Redacted.value(key), { limit: "lots" });

          expect(yield* providers.openrouter.budget).toEqual(
            Option.some({ error: "OpenRouter answered with a key budget via can't read" }),
          );
        }),
      );
    }),
  );

  it.effect("forgets the key and its models once removed", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;

      yield* withOpenrouter(openrouter(fake), (providers) =>
        Effect.gen(function* () {
          yield* providers.openrouter.setKey(key);
          yield* providers.openrouter.setModels(["openai/gpt-6"]);
          yield* providers.openrouter.remove;

          expect(yield* providers.openrouter.get).toEqual(Option.none());
          expect(providers.route("openrouter/openai/gpt-6")).toEqual(Option.none());
          expect(yield* providers.names).toEqual([]);
        }),
      );
    }),
  );

  it.effect("leaves OpenRouter to config.yaml when it names the key, with all its models", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.models(["openai/gpt-6", "anthropic/claude-5"]);

      yield* withOpenrouter(
        { openrouter: { baseUrl: fake.url, apiKeyEnv: "OPENROUTER_API_KEY" } },
        (providers) =>
          Effect.gen(function* () {
            expect(yield* providers.openrouter.get).toEqual(
              Option.some({ key: "…abcd", models: [], fromConfig: true }),
            );
            expect(yield* Effect.exit(providers.openrouter.setKey(key))).toEqual(
              Exit.fail(new OpenrouterNotEditableError()),
            );
            expect((yield* providers.models).map(({ model }) => model.id)).toEqual([
              "openrouter/openai/gpt-6",
              "openrouter/anthropic/claude-5",
            ]);
          }),
        { openrouter: key },
      );
    }),
  );
});
