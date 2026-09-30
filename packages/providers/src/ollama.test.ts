import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import type { ProviderConfig } from "@via/config";
import { Effect, Exit, FileSystem, Layer, Option, type Scope } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OllamaNotEditableError, OllamaUnreachableError } from "./errors.ts";
import { OllamaAddress, OpencodeGoAccounts, Providers } from "./index.ts";
import { startFakeProvider } from "./testing/index.ts";

/** Providers set up by `configs`, with an address file that holds `saved`, if anything. */
const withOllama = <A, E>(
  configs: Record<string, ProviderConfig>,
  body: (
    providers: Providers["Service"],
  ) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
  saved?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();

    if (saved !== undefined) {
      yield* fs.writeFileString(`${dir}/ollama.json`, JSON.stringify({ address: saved }));
    }

    return yield* Effect.flatMap(Providers, body).pipe(
      Effect.provide(
        Providers.layer({ providers: configs, apiKeys: {}, version: "1.2.3" }).pipe(
          Layer.provide([
            FetchHttpClient.layer,
            OpencodeGoAccounts.layer(`${dir}/go.json`),
            OllamaAddress.layer(`${dir}/ollama.json`),
          ]),
        ),
      ),
    );
  });

/** Why checking `address` fails. */
const failure = (address: string) =>
  withOllama({}, (providers) => Effect.flip(providers.ollama.check(address)));

layer(BunFileSystem.layer)("Providers' Ollama", (it) => {
  it.effect("routes to the Ollama saved in the web UI at once, and no more once removed", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.models(["nimble"]);

      yield* withOllama({}, (providers) =>
        Effect.gen(function* () {
          expect(providers.route("ollama/nimble")).toEqual(Option.none());
          expect(yield* providers.ollama.get).toEqual(Option.none());

          yield* providers.ollama.set(fake.url);

          expect(providers.route("ollama/nimble")).toEqual(
            Option.some({ provider: "ollama", model: "nimble", pooled: false }),
          );
          expect(yield* providers.names).toEqual(["ollama"]);
          expect(yield* providers.local).toEqual(["ollama"]);
          expect((yield* providers.models).map(({ model }) => model.id)).toEqual(["ollama/nimble"]);
          expect(fake.modelRequests.at(-1)?.path).toBe("/v1/models");
          expect(yield* providers.ollama.get).toEqual(
            Option.some({ address: fake.url, fromConfig: false }),
          );

          yield* providers.ollama.remove;

          expect(providers.route("ollama/nimble")).toEqual(Option.none());
          expect(yield* providers.names).toEqual([]);
        }),
      );
    }),
  );

  it.effect("starts with the Ollama saved before", () =>
    withOllama(
      {},
      (providers) =>
        Effect.sync(() =>
          expect(providers.route("ollama/nimble")).toEqual(
            Option.some({ provider: "ollama", model: "nimble", pooled: false }),
          ),
        ),
      "http://nas:11434",
    ),
  );

  it.effect("leaves Ollama to config.yaml when it sets one up", () =>
    withOllama(
      { ollama: { baseUrl: "http://gpu-box:11434/v1" } },
      (providers) =>
        Effect.gen(function* () {
          expect(yield* providers.ollama.get).toEqual(
            Option.some({ address: "http://gpu-box:11434", fromConfig: true }),
          );

          const set = yield* Effect.exit(providers.ollama.set("http://localhost:11434"));
          expect(set).toEqual(Exit.fail(new OllamaNotEditableError()));
          expect(Exit.isFailure(yield* Effect.exit(providers.ollama.remove))).toBe(true);
        }),
      "http://nas:11434",
    ),
  );

  it.effect("shows config.yaml's Ollama at its default address when it gives none", () =>
    withOllama({ ollama: {} }, (providers) =>
      Effect.gen(function* () {
        expect(yield* providers.ollama.get).toEqual(
          Option.some({ address: "http://localhost:11434", fromConfig: true }),
        );
      }),
    ),
  );

  it.effect("checks an address: the Ollama version there, and its models", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.ollama("0.35.0");
      fake.models(["nimble", "llama3.2"]);

      const found = yield* withOllama({}, (providers) => providers.ollama.check(fake.url));

      expect(found).toEqual({ version: "0.35.0", models: ["nimble", "llama3.2"] });
    }),
  );

  it.effect("says why an address isn't an Ollama it can use", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.models(["nimble"]);

      expect(yield* failure("http://127.0.0.1:1")).toEqual(
        new OllamaUnreachableError({ reason: "nothing answered there" }),
      );
      expect(yield* failure(fake.url)).toEqual(
        new OllamaUnreachableError({ reason: "what answered there isn't Ollama" }),
      );
    }),
  );
});
