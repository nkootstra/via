import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import type { ProviderConfig } from "@via/config";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Record,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { Providers } from "./index.ts";
import { providerReply, startFakeProvider } from "./testing/index.ts";

/**
 * Runs `body` with `configs` providers, `apiKeys` as their keys (by default
 * `sk-test` for each), and `client` as the network.
 */
const withProviders = <A, E, R>(
  configs: Record<string, ProviderConfig>,
  body: (providers: Providers["Service"]) => Effect.Effect<A, E, R>,
  apiKeys: Record<string, string> = Record.map(configs, () => "sk-test"),
  client: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer,
) =>
  Effect.gen(function* () {
    return yield* body(yield* Providers);
  }).pipe(
    Effect.provide(
      Providers.layer({
        providers: configs,
        apiKeys: Record.map(apiKeys, (key) => Redacted.make(key)),
        version: "1.2.3",
      }).pipe(Layer.provide(client)),
    ),
  );

/** A network that answers every request 503, recording the URLs asked for. */
const offline = () => {
  const urls: Array<string> = [];

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      urls.push(request.url);

      return HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }));
    }),
  );

  return { urls, client: Layer.succeed(HttpClient.HttpClient, client) };
};

/** The request `name` sends for `body` in session "conv-1", configured as `config`. */
const sent = (name: string, body: Schema.JsonObject, config: Partial<ProviderConfig> = {}) =>
  Effect.gen(function* () {
    const fake = yield* startFakeProvider;
    fake.respond(providerReply.json({}));
    yield* withProviders(
      { [name]: { baseUrl: fake.url, apiKeyEnv: "KEY", ...config } },
      (providers) =>
        providers.send({ provider: name, model: "m" }, "/chat/completions", body, "conv-1"),
    );

    return fake.requests[0];
  });

layer(BunFileSystem.layer)("Providers", (it) => {
  it.effect("routes a model whose prefix names a configured provider", () =>
    withProviders({ local: { baseUrl: "http://x", apiKeyEnv: "KEY" } }, (providers) =>
      Effect.sync(() => {
        expect(providers.route("local/qwen/qwen3")).toEqual(
          Option.some({ provider: "local", model: "qwen/qwen3" }),
        );
        expect(providers.route("gpt-6-astra")).toEqual(Option.none());
        expect(providers.route("other/qwen3")).toEqual(Option.none());
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
            "conv-1",
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
            "user-agent": "via/1.2.3",
          }),
          body: { model: "qwen/qwen3", temperature: 0.2, messages: [] },
        }),
      ]);
    }),
  );

  it.effect("knows OpenRouter's and OpenCode Go's URLs without a baseUrl", () =>
    Effect.gen(function* () {
      const { urls, client } = offline();
      yield* withProviders(
        { openrouter: { apiKeyEnv: "KEY" }, "opencode-go": { apiKeyEnv: "KEY" } },
        (providers) =>
          Effect.gen(function* () {
            yield* providers.models;
            yield* providers.usage;
            yield* providers.send({ provider: "openrouter", model: "m" }, "/responses", {}, "c");
          }),
        undefined,
        client,
      );

      expect(urls.toSorted()).toEqual([
        "https://opencode.ai/zen/go/v1/models",
        "https://opencode.ai/zen/go/v1/usage",
        "https://openrouter.ai/api/v1/models",
        "https://openrouter.ai/api/v1/responses",
      ]);
    }),
  );

  it.effect("rejects a provider it doesn't know that has no baseUrl", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withProviders({ mystery: { apiKeyEnv: "KEY" } }, () => Effect.void),
      );

      expect(error.message).toMatch(/mystery.*baseUrl/);
    }),
  );

  it.effect("fails naming the environment variable when its API key is not given", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        withProviders({ openrouter: { apiKeyEnv: "OPENROUTER_API_KEY" } }, () => Effect.void, {}),
      );

      expect(error.message).toBe(
        `Provider "openrouter" reads its API key from OPENROUTER_API_KEY, which is not set`,
      );
    }),
  );

  it.effect("joins a baseUrl that ends in a slash without doubling it", () =>
    Effect.gen(function* () {
      const { urls, client } = offline();
      yield* withProviders(
        { local: { baseUrl: "http://local.test/v1/", apiKeyEnv: "KEY" } },
        (providers) =>
          Effect.andThen(
            providers.send({ provider: "local", model: "m" }, "/chat/completions", {}, "conv-1"),
            providers.models,
          ),
        undefined,
        client,
      );

      expect(urls).toEqual([
        "http://local.test/v1/chat/completions",
        "http://local.test/v1/models",
      ]);
    }),
  );

  it.effect("sends the body as JSON", () =>
    Effect.gen(function* () {
      const request = yield* sent("local", { model: "local/m", messages: [] });
      expect(request?.headers["content-type"]).toBe("application/json");
      expect(request?.body).toEqual({ model: "m", messages: [] });
    }),
  );

  it.effect("sends OpenCode Go the session in x-opencode-session", () =>
    Effect.gen(function* () {
      const request = yield* sent("opencode-go", { model: "opencode-go/m" });
      expect(request?.headers["x-opencode-session"]).toBe("conv-1");
      expect(request?.body).toEqual({ model: "m" });
    }),
  );

  it.effect("sends OpenRouter the session in the body, keeping the client's cache key", () =>
    Effect.gen(function* () {
      expect((yield* sent("openrouter", { model: "openrouter/m" }))?.body).toEqual({
        model: "m",
        session_id: "conv-1",
        prompt_cache_key: "conv-1",
      });
      expect(
        (yield* sent("openrouter", { model: "openrouter/m", prompt_cache_key: "mine" }))?.body,
      ).toEqual({ model: "m", session_id: "conv-1", prompt_cache_key: "mine" });
    }),
  );

  it.effect("sends the session in the header a provider's config names", () =>
    Effect.gen(function* () {
      const request = yield* sent(
        "litellm",
        { model: "litellm/m" },
        {
          sessionHeader: "x-litellm-session-id",
        },
      );

      expect(request?.headers["x-litellm-session-id"]).toBe("conv-1");
    }),
  );

  it.effect("sends a built-in provider the session where its config's sessionHeader says", () =>
    Effect.gen(function* () {
      const request = yield* sent(
        "openrouter",
        { model: "openrouter/m" },
        { sessionHeader: "x-session-id" },
      );

      expect(request?.headers["x-session-id"]).toBe("conv-1");
      expect(request?.body).toEqual({ model: "m" });
    }),
  );

  it.effect("sends no session to a provider that has no place for it", () =>
    Effect.gen(function* () {
      const request = yield* sent("local", { model: "local/m" });
      expect(request?.body).toEqual({ model: "m" });
      expect(Object.values(request?.headers ?? {})).not.toContain("conv-1");
    }),
  );

  it.effect("hands back a streamed answer as it arrives, before the provider ends it", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.respond(providerReply.sseThenHang("data: {}\n\n"));

      const first = yield* withProviders(
        { local: { baseUrl: fake.url, apiKeyEnv: "KEY" } },
        (providers) =>
          Effect.gen(function* () {
            const response = yield* providers.send(
              { provider: "local", model: "m" },
              "/chat/completions",
              { stream: true },
              "conv-1",
            );

            expect(response.headers["content-type"]).toBe("text/event-stream");

            return yield* response.stream.pipe(Stream.decodeText, Stream.runHead);
          }),
      );

      expect(first).toEqual(Option.some("data: {}\n\n"));
    }),
  );

  it.effect("fails the answer's stream when the provider breaks it off", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      const received = yield* Deferred.make<void>();
      fake.respond(providerReply.sseThenDrop("data: {}\n\n", Deferred.await(received)));

      const outcome = yield* withProviders(
        { local: { baseUrl: fake.url, apiKeyEnv: "KEY" } },
        (providers) =>
          providers.send({ provider: "local", model: "m" }, "/responses", {}, "conv-1").pipe(
            Effect.flatMap((response) =>
              response.stream.pipe(
                Stream.tap(() => Deferred.succeed(received, undefined)),
                Stream.decodeText,
                Stream.mkString,
              ),
            ),
            Effect.catchTag("HttpClientError", () => Effect.succeed("broke off")),
          ),
      );

      expect(outcome).toBe("broke off");
    }),
  );

  it.effect("treats a route to a provider that isn't configured as a defect", () =>
    Effect.gen(function* () {
      const exit = yield* withProviders({}, (providers) =>
        Effect.exit(providers.send({ provider: "nope", model: "m" }, "/responses", {}, "conv-1")),
      );

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect("lists every provider's models as it describes them, skipping one that is down", () =>
    Effect.gen(function* () {
      const up = yield* startFakeProvider;
      const qwen = { id: "qwen/qwen3", created: 1_780_000_000, context_length: 262_144 };
      up.models([qwen, "kimi-k3"]);
      const down = yield* startFakeProvider;

      const models = yield* withProviders(
        {
          up: { baseUrl: up.url, apiKeyEnv: "KEY" },
          down: { baseUrl: down.url, apiKeyEnv: "KEY" },
        },
        (providers) => providers.models,
      );

      expect(models).toEqual([
        { provider: "up", model: { ...qwen, id: "up/qwen/qwen3" } },
        { provider: "up", model: { id: "up/kimi-k3", object: "model" } },
      ]);
      expect(up.modelRequests[0]?.headers["authorization"]).toBe("Bearer sk-test");
    }),
  );

  it.effect("reports OpenCode Go's usage, and none for a provider without a usage endpoint", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.usage({
        usage: {
          rolling: { status: "ok", percent: 0, resetsAt: "2026-09-26T23:40:07.697Z" },
          weekly: { status: "ok", percent: 26, resetsAt: "2026-09-28T00:00:00.000Z" },
          monthly: { status: "ok", percent: 14, resetsAt: "2026-10-13T09:11:26.000Z" },
        },
      });

      const usage = yield* withProviders(
        {
          "opencode-go": { baseUrl: fake.url, apiKeyEnv: "KEY" },
          local: { baseUrl: fake.url, apiKeyEnv: "KEY" },
        },
        (providers) => providers.usage,
      );

      expect(usage).toEqual([
        {
          provider: "opencode-go",
          windows: [
            {
              window: "rolling",
              status: "ok",
              usedPercent: 0,
              resetsAt: "2026-09-26T23:40:07.697Z",
            },
            {
              window: "weekly",
              status: "ok",
              usedPercent: 26,
              resetsAt: "2026-09-28T00:00:00.000Z",
            },
            {
              window: "monthly",
              status: "ok",
              usedPercent: 14,
              resetsAt: "2026-10-13T09:11:26.000Z",
            },
          ],
        },
      ]);
      expect(fake.usageRequests).toEqual([
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer sk-test" }),
        }),
      ]);
    }),
  );

  it.effect("says a provider's usage is unavailable when its answer can't be read", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.usage({ usage: { weekly: { percent: "a lot" } } });

      const usage = yield* withProviders(
        { "opencode-go": { baseUrl: fake.url, apiKeyEnv: "KEY" } },
        (providers) => providers.usage,
      );

      expect(usage).toEqual([{ provider: "opencode-go", error: expect.any(String) }]);
    }),
  );

  it.effect("says why a provider's usage is unavailable", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeProvider;
      fake.usage({ error: "unauthorized" }, 401);

      const usage = yield* withProviders(
        { "opencode-go": { baseUrl: fake.url, apiKeyEnv: "KEY" } },
        (providers) => providers.usage,
      );

      expect(usage).toEqual([
        { provider: "opencode-go", error: "opencode-go did not report usage (HTTP 401)" },
      ]);
    }),
  );
});
