import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply } from "@via/providers/testing";
import { Effect, Schema } from "effect";
import { ok, type Via, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

const apiKey = "sk-or-v1-abcd";

const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** The ids of the models via lists. */
const modelIds = (via: Via) =>
  Effect.gen(function* () {
    const { data } = yield* Schema.decodeUnknownEffect(Models)(
      yield* (yield* via.get("/v1/models")).json,
    );

    return data.map(({ id }) => id);
  });

/** OpenRouter as the fake plays it: it takes `apiKey` and lists three models. */
const openrouter = (via: Via) => {
  via.provider.openrouterKey(apiKey, { label: "sk-or-v1-abc...", usage: 0, limit: null });
  via.provider.models([
    {
      id: "openai/gpt-6",
      name: "OpenAI: GPT-6",
      pricing: { prompt: "0.000002", completion: "0.00001" },
      context_length: 400_000,
    },
    "anthropic/claude-5",
    "google/gemini-4",
  ]);
};

const options = { adminKey, openrouterFromUi: true };

layer(BunFileSystem.layer)("admin API, OpenRouter", (it) => {
  it.effect("takes a key OpenRouter accepts, shown only by its last four characters", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          openrouter(via);
          expect(yield* (yield* via.get("/admin/openrouter", adminKey)).json).toBeNull();

          const saved = yield* via.put("/admin/openrouter/key", { apiKey }, adminKey);
          expect(saved.status).toBe(200);
          expect(yield* saved.json).toEqual({ key: "…abcd", models: [], fromConfig: false });

          const refused = yield* via.put("/admin/openrouter/key", { apiKey: "sk-no" }, adminKey);
          expect(refused.status).toBe(422);
          expect(yield* refused.json).toMatchObject({ status: 401 });
        }),
      options,
    ),
  );

  it.effect("lists OpenRouter's models to pick from, with their prices per million tokens", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          openrouter(via);
          const early = yield* via.get("/admin/openrouter/catalog", adminKey);
          expect(early.status).toBe(409);

          yield* via.put("/admin/openrouter/key", { apiKey }, adminKey);
          const catalog = yield* via.get("/admin/openrouter/catalog", adminKey);

          expect(catalog.status).toBe(200);
          expect(yield* catalog.json).toEqual([
            {
              id: "openai/gpt-6",
              name: "OpenAI: GPT-6",
              inputPerMillion: 2,
              outputPerMillion: 10,
              contextLength: 400_000,
            },
            {
              id: "anthropic/claude-5",
              name: "anthropic/claude-5",
              inputPerMillion: null,
              outputPerMillion: null,
              contextLength: null,
            },
            {
              id: "google/gemini-4",
              name: "google/gemini-4",
              inputPerMillion: null,
              outputPerMillion: null,
              contextLength: null,
            },
          ]);
        }),
      options,
    ),
  );

  it.effect("offers only the models enabled, and refuses the rest by name", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          openrouter(via);
          via.provider.respond(providerReply.json({ id: "chatcmpl-or" }));
          yield* via.put("/admin/openrouter/key", { apiKey }, adminKey);

          const enabled = yield* via.put(
            "/admin/openrouter/models",
            { models: ["openai/gpt-6"] },
            adminKey,
          );

          expect(yield* enabled.json).toEqual({
            key: "…abcd",
            models: ["openai/gpt-6"],
            fromConfig: false,
          });

          const ids = yield* modelIds(via);
          expect(ids).toContain("openrouter/openai/gpt-6");
          expect(ids).not.toContain("openrouter/anthropic/claude-5");

          const chat = yield* via.post("/v1/chat/completions", {
            model: "openrouter/openai/gpt-6",
            messages: [],
          });

          expect(yield* chat.json).toEqual({ id: "chatcmpl-or" });
          expect(via.provider.requests[0]?.headers["authorization"]).toBe(`Bearer ${apiKey}`);

          const refused = yield* via.post("/v1/chat/completions", {
            model: "openrouter/anthropic/claude-5",
            messages: [],
          });

          expect(refused.status).toBe(404);
          expect(yield* refused.json).toMatchObject({
            error: {
              code: "model_not_found",
              message:
                "openrouter/anthropic/claude-5 isn't enabled: enable it under OpenRouter on via's Accounts page",
            },
          });
          expect(via.provider.requests).toHaveLength(1);
        }),
      options,
    ),
  );

  it.effect("lists a change to the models enabled at once, not once the list is old", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          openrouter(via);
          yield* via.put("/admin/openrouter/key", { apiKey }, adminKey);
          yield* via.put("/admin/openrouter/models", { models: ["openai/gpt-6"] }, adminKey);
          expect(yield* modelIds(via)).toContain("openrouter/openai/gpt-6");

          yield* via.put("/admin/openrouter/models", { models: ["google/gemini-4"] }, adminKey);

          const ids = yield* modelIds(via);
          expect(ids).toContain("openrouter/google/gemini-4");
          expect(ids).not.toContain("openrouter/openai/gpt-6");
        }),
      options,
    ),
  );

  it.effect("forgets the key once removed", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          openrouter(via);
          yield* via.put("/admin/openrouter/key", { apiKey }, adminKey);
          yield* via.put("/admin/openrouter/models", { models: ["openai/gpt-6"] }, adminKey);

          expect((yield* via.delete("/admin/openrouter", adminKey)).status).toBe(204);
          expect(yield* (yield* via.get("/admin/openrouter", adminKey)).json).toBeNull();
          expect(yield* modelIds(via)).not.toContain("openrouter/openai/gpt-6");
        }),
      options,
    ),
  );

  it.effect("shows config.yaml's OpenRouter, and leaves it to config.yaml", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect(yield* (yield* via.get("/admin/openrouter", adminKey)).json).toEqual({
            key: "…ider",
            models: [],
            fromConfig: true,
          });
          expect((yield* via.put("/admin/openrouter/key", { apiKey }, adminKey)).status).toBe(409);
          expect((yield* via.delete("/admin/openrouter", adminKey)).status).toBe(409);
        }),
      { adminKey },
    ),
  );
});
