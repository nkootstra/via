import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { FallbackRuleInvalidError, FallbackRuleNotFoundError } from "@via/fallbacks";
import { Effect, Schema } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

const sol = { model: "gpt-x", fallbacks: ["opencode-go/kimi-k3", "gpt-y"] };

const standingBy = {
  source: { status: "available" },
  fallbacks: [{ status: "available" }, { status: "available" }],
  serving: "gpt-x",
};

layer(BunFileSystem.layer)("admin API, fallbacks", (it) => {
  it.effect("sets a model's fallbacks, lists them, and changes them in place", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect(yield* (yield* via.get("/admin/fallbacks", adminKey)).json).toEqual([]);

          const saved = yield* via.put("/admin/fallbacks", sol, adminKey);
          expect(saved.status).toBe(200);
          expect(yield* saved.json).toEqual({ ...sol, status: standingBy });

          yield* via.put("/admin/fallbacks", { model: "gpt-z", fallbacks: ["gpt-y"] }, adminKey);
          yield* via.put("/admin/fallbacks", { model: "gpt-x", fallbacks: ["gpt-y"] }, adminKey);

          const listed = yield* (yield* via.get("/admin/fallbacks", adminKey)).json;
          expect(listed).toMatchObject([
            { model: "gpt-x", fallbacks: ["gpt-y"] },
            { model: "gpt-z", fallbacks: ["gpt-y"] },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("refuses fallbacks a model can't have, saying why", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const itself = yield* via.put(
            "/admin/fallbacks",
            { model: "gpt-x", fallbacks: ["gpt-x"] },
            adminKey,
          );

          expect(itself.status).toBe(400);
          expect(
            yield* Schema.decodeUnknownEffect(FallbackRuleInvalidError)(yield* itself.json),
          ).toEqual(new FallbackRuleInvalidError({ problem: "gpt-x can't fall back to itself" }));
          expect(
            (yield* via.put("/admin/fallbacks", { model: "gpt-x", fallbacks: [] }, adminKey))
              .status,
          ).toBe(400);
        }),
      { adminKey },
    ),
  );

  it.effect("removes a model's fallbacks by its id, a provider's included", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const model = "openrouter/openai/gpt-6";
          yield* via.put("/admin/fallbacks", { model, fallbacks: ["gpt-x"] }, adminKey);

          const path = `/admin/fallbacks?model=${encodeURIComponent(model)}`;
          expect((yield* via.delete(path, adminKey)).status).toBe(204);
          expect(yield* (yield* via.get("/admin/fallbacks", adminKey)).json).toEqual([]);

          const missing = yield* via.delete(path, adminKey);
          expect(missing.status).toBe(404);
          expect(
            yield* Schema.decodeUnknownEffect(FallbackRuleNotFoundError)(yield* missing.json),
          ).toEqual(new FallbackRuleNotFoundError({ model }));
        }),
      { adminKey },
    ),
  );

  it.effect("says which model would answer now, while a model's accounts cool down", () =>
    withVia(
      () => reply.error(429, "", { "retry-after": "120" }),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-y", input: "hi" });
          yield* via.put("/admin/fallbacks", sol, adminKey);

          const rules = yield* (yield* via.get("/admin/fallbacks", adminKey)).json;
          expect(rules).toMatchObject([
            {
              status: {
                source: { status: "cooling", until: expect.any(String), reason: "rate_limited" },
                fallbacks: [{ status: "available" }, { status: "cooling" }],
                serving: "opencode-go/kimi-k3",
              },
            },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("says when no model of a rule can answer", () =>
    withVia(
      () => reply.error(429, "", { "retry-after": "120" }),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-y", input: "hi" });
          yield* via.put(
            "/admin/fallbacks",
            { model: "gpt-x", fallbacks: ["opencode-go/kimi-k3", "gpt-y"] },
            adminKey,
          );

          const rules = yield* (yield* via.get("/admin/fallbacks", adminKey)).json;
          expect(rules).toMatchObject([
            {
              status: {
                fallbacks: [
                  { status: "unavailable", reason: "no_accounts" },
                  { status: "cooling", reason: "rate_limited" },
                ],
                serving: null,
              },
            },
          ]);
        }),
      { adminKey, opencodeGoKeys: [] },
    ),
  );

  it.effect("says an OpenRouter model that isn't enabled can't answer", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.openrouterKey("sk-or-v1-abcd", { label: "sk-or", usage: 0, limit: null });
          yield* via.put("/admin/openrouter/key", { apiKey: "sk-or-v1-abcd" }, adminKey);
          yield* via.put(
            "/admin/fallbacks",
            { model: "gpt-x", fallbacks: ["openrouter/a/b"] },
            adminKey,
          );

          const rules = yield* (yield* via.get("/admin/fallbacks", adminKey)).json;
          expect(rules).toMatchObject([
            { status: { fallbacks: [{ status: "unavailable", reason: "not_enabled" }] } },
          ]);
        }),
      { adminKey, openrouterFromUi: true },
    ),
  );

  it.effect("needs the admin key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/fallbacks")).status).toBe(401);
        }),
      { adminKey },
    ),
  );
});
