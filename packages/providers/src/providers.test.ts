import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import type { ProviderConfig } from "@via/config";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Providers } from "./index.ts";
import { providerReply, startFakeProvider } from "./testing/index.ts";

/** Runs `body` with `configs` providers and `env` as the environment. */
const withProviders = <A, E, R>(
  configs: Record<string, ProviderConfig>,
  body: (providers: Providers["Service"]) => Effect.Effect<A, E, R>,
  env: Record<string, string> = { KEY: "sk-test" },
) =>
  Effect.gen(function* () {
    return yield* body(yield* Providers);
  }).pipe(
    Effect.provide(
      Providers.layer(configs).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      ),
    ),
  );

layer(BunFileSystem.layer)("Providers", (it) => {
  it.effect("routes a model whose prefix names a configured provider", () =>
    withProviders({ local: { baseUrl: "http://x", apiKeyEnv: "KEY" } }, (providers) =>
      Effect.sync(() => {
        expect(providers.route("local/qwen/qwen3")).toEqual(
          Option.some({ provider: "local", model: "qwen/qwen3" }),
        );
        expect(providers.route("gpt-6-astra")).toEqual(Option.none());
        expect(providers.route("other/qwen3")).toEqual(Option.none());
        expect(providers.route(42)).toEqual(Option.none());
      }),
    ),
  );

  it.effect("forwards the body to the provider with the prefix stripped", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.respond(providerReply.json({ id: "chatcmpl-1" }));
      yield* withProviders({ local: { baseUrl: fake.url, apiKeyEnv: "KEY" } }, (providers) =>
        Effect.gen(function* () {
          const response = yield* providers.send(
            { provider: "local", model: "qwen/qwen3" },
            "/chat/completions",
            { model: "local/qwen/qwen3", temperature: 0.2, messages: [] },
          );
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual({ id: "chatcmpl-1" });
        }),
      );
      expect(fake.requests).toEqual([
        expect.objectContaining({
          path: "/chat/completions",
          headers: expect.objectContaining({
            authorization: "Bearer sk-test",
            "user-agent": expect.stringMatching(/^via\//),
          }),
          body: { model: "qwen/qwen3", temperature: 0.2, messages: [] },
        }),
      ]);
    }),
  );

  it.effect("knows OpenRouter and OpenCode Go without a baseUrl", () =>
    withProviders(
      { openrouter: { apiKeyEnv: "KEY" }, "opencode-go": { apiKeyEnv: "KEY" } },
      (providers) =>
        Effect.sync(() => {
          expect(providers.baseUrl("openrouter")).toBe("https://openrouter.ai/api/v1");
          expect(providers.baseUrl("opencode-go")).toBe("https://opencode.ai/zen/go/v1");
        }),
    ),
  );

  it.effect("rejects a provider it doesn't know that has no baseUrl", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withProviders({ mystery: { apiKeyEnv: "KEY" } }, () => Effect.void),
      );
      expect(error.message).toMatch(/mystery.*baseUrl/);
    }),
  );

  it.effect("fails naming the environment variable when the API key is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withProviders({ openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" } }, () => Effect.void, {}),
      );
      expect(error.message).toMatch(/OPENROUTER_API_KEY/);
    }),
  );
});
