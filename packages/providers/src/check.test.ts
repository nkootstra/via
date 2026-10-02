import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import type { ProviderConfig } from "@via/config";
import { Effect, FileSystem, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { OpencodeGoAccounts, Providers } from "./index.ts";
import { startFakeProvider } from "./testing/index.ts";

/** How checking provider `name` ends, set up by `configs` and `apiKeys`. */
const check = (
  name: string,
  configs: Record<string, ProviderConfig>,
  apiKeys: Record<string, Redacted.Redacted<string>> = {},
) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

    return yield* Effect.flatMap(Providers, (providers) => providers.check(name)).pipe(
      Effect.match({ onFailure: (error) => error.message, onSuccess: () => "available" }),
      Effect.provide(
        Providers.layer({ providers: configs, apiKeys, version: "1.2.3" }).pipe(
          Layer.provide([FetchHttpClient.layer, OpencodeGoAccounts.layer(`${dir}/go.json`)]),
        ),
      ),
    );
  });

layer(BunFileSystem.layer)("Providers.check", (it) => {
  it.effect("finds a provider that lists its models available", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.models(["m"]);
      const local = { local: { baseUrl: fake.url } };
      expect(yield* check("local", local)).toBe("available");
    }),
  );

  it.effect("says when a provider answers its models with an error", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      const local = { local: { baseUrl: fake.url } };
      expect(yield* check("local", local)).toBe("Could not reach local: HTTP 500");
    }),
  );

  it.effect("says when nothing answers at a provider's address", () =>
    Effect.gen(function* () {
      const local = { local: { baseUrl: "http://127.0.0.1:1" } };
      expect(yield* check("local", local)).toBe("Could not reach local: it could not be reached");
    }),
  );

  it.effect("checks OpenRouter's key with OpenRouter", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.openrouterKey("sk-good", { limit: null });
      const configs = { openrouter: { baseUrl: fake.url, apiKeyEnv: "OR_KEY" } };
      expect(yield* check("openrouter", configs, { openrouter: Redacted.make("sk-good") })).toBe(
        "available",
      );
      expect(yield* check("openrouter", configs, { openrouter: Redacted.make("sk-bad") })).toBe(
        "openrouter refused its API key (HTTP 401)",
      );
    }),
  );

  it.effect("checks Ollama by asking for its version", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.models(["nimble"]);
      const configs = { ollama: { baseUrl: `${fake.url}/v1` } };
      expect(yield* check("ollama", configs)).toBe(
        "Could not reach ollama: what answered there isn't Ollama",
      );
      fake.ollama("0.12.0");
      expect(yield* check("ollama", configs)).toBe("available");
    }),
  );
});
