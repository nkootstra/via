import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { startFakeProvider } from "@via/providers/testing";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpClientResponse } from "effect/unstable/http";
import { type Via, ok, withVia } from "./testing/harness.ts";

const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
});

/** The model ids a `/v1/models` answer lists. */
const ids = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(HttpClientResponse.schemaBodyJson(ModelList)(response), (list) =>
    list.data.map((model) => model.id),
  );

const listed = (via: Via) => via.get("/v1/models").pipe(Effect.flatMap(ids));

const catalog = {
  models: [
    {
      slug: "gpt-7",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    },
  ],
};

layer(BunFileSystem.layer)("GET /v1/models", (it) => {
  it.effect("lists the models Codex offers the accounts, with their effort aliases", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.get("/v1/models");
            expect(yield* ids(response)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
            expect(
              codex.modelRequests
                .map((request) => request.headers["chatgpt-account-id"])
                .toSorted(),
            ).toEqual(["acc-a", "acc-b"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("combines the models every account offers, as plans differ", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(
        { models: [{ slug: "gpt-7", supported_reasoning_levels: [{ effort: "low" }] }] },
        "acc-a",
      );
      codex.models(
        {
          models: [
            { slug: "gpt-7", supported_reasoning_levels: [{ effort: "high" }] },
            { slug: "daybreak" },
          ],
        },
        "acc-b",
      );
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.get("/v1/models");
            expect(yield* ids(response)).toEqual(["gpt-7", "daybreak", "gpt-7-low", "gpt-7-high"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("asks Codex and the providers as soon as via starts", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            // One ask per account, before any request.
            yield* codex.modelsReceived(2);
            yield* via.provider.modelsReceived(2);
            expect(yield* listed(via)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
            expect(codex.modelRequests).toHaveLength(2);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("skips an account whose refresh token is rejected and asks the next", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.get("/v1/models");
            expect(yield* ids(response)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
            expect(
              codex.modelRequests.map((request) => request.headers["chatgpt-account-id"]),
            ).toEqual(["acc-b"]);
          }),
        {
          codexUrl: codex.url,
          refreshResponse: { status: 400, body: { error: "invalid_grant" } },
          aExpiresAt: 0,
        },
      );
    }),
  );

  it.effect("skips an account whose refresh hits an auth-server hiccup and asks the next", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.get("/v1/models");
            expect(yield* ids(response)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
            expect(
              codex.modelRequests.map((request) => request.headers["chatgpt-account-id"]),
            ).toEqual(["acc-b"]);
          }),
        {
          codexUrl: codex.url,
          refreshResponse: { status: 500, body: { error: "server_error" } },
          aExpiresAt: 0,
        },
      );
    }),
  );

  it.effect("answers from the listed catalog while it asks Codex again after five minutes", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* via.get("/v1/models");
            yield* via.get("/v1/models");
            // One ask per account.
            expect(codex.modelRequests).toHaveLength(2);
            codex.models({ models: [{ slug: "gpt-8" }] });
            yield* TestClock.adjust("5 minutes");
            expect(yield* listed(via)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
            expect(
              yield* listed(via).pipe(Effect.repeat({ until: (list) => list[0] === "gpt-8" })),
            ).toEqual(["gpt-8"]);
            expect(codex.modelRequests).toHaveLength(4);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("keeps the listed catalog when asking Codex again fails", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* via.get("/v1/models");
            codex.models("not a catalog");
            yield* TestClock.adjust("5 minutes");

            // A second round of asks means the first one failed and was let go.
            const last = yield* listed(via).pipe(
              Effect.repeat({ until: () => codex.modelRequests.length >= 6 }),
            );

            expect(last).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("falls back to the bundled models when Codex does not list any", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/v1/models");
        expect(response.status).toBe(200);
        const list = yield* response.json;
        expect(list).toMatchObject({ object: "list" });
        expect(list).toHaveProperty(
          "data",
          expect.arrayContaining([
            {
              id: "gpt-6-astra",
              object: "model",
              created: 0,
              owned_by: "openai",
            },
            {
              id: "gpt-6-astra-high",
              object: "model",
              created: 0,
              owned_by: "openai",
            },
          ]),
        );
      }),
    ),
  );

  it.effect("rejects a request without an API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/v1/models", null);
        expect(response.status).toBe(401);
      }),
    ),
  );

  it.effect("lists each provider's models under its prefix, asking again after five minutes", () =>
    Effect.gen(function* () {
      // Scripted before via starts, as via asks as it starts.
      const provider = yield* startFakeProvider;
      provider.models([
        "qwen/qwen3",
        {
          id: "kimi-k3",
          object: "model",
          created: 1_780_000_000,
          owned_by: "moonshot",
          context_length: 262_144,
        },
      ]);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const list = yield* (yield* via.get("/v1/models")).json;
            expect(list).toHaveProperty(
              "data",
              expect.arrayContaining([
                {
                  id: "openrouter/qwen/qwen3",
                  object: "model",
                  created: 0,
                  owned_by: "openrouter",
                },
                {
                  id: "opencode-go/qwen/qwen3",
                  object: "model",
                  created: 0,
                  owned_by: "opencode-go",
                },
                {
                  id: "openrouter/kimi-k3",
                  object: "model",
                  created: 1_780_000_000,
                  owned_by: "moonshot",
                  context_length: 262_144,
                },
                expect.objectContaining({ id: "gpt-6-astra", owned_by: "openai" }),
              ]),
            );
            yield* via.get("/v1/models");
            expect(provider.modelRequests).toHaveLength(2);
            yield* TestClock.adjust("5 minutes");
            yield* listed(via).pipe(
              Effect.repeat({ until: () => provider.modelRequests.length >= 4 }),
            );
            expect(provider.modelRequests).toHaveLength(4);
          }),
        { providerUrl: provider.url },
      );
    }),
  );
});
