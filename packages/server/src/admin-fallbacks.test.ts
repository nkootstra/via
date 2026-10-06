import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { FallbackRuleInvalidError, FallbackRuleNotFoundError } from "@via/fallbacks";
import { Effect, FileSystem, Schema } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

const sol = { model: "gpt-6-astra", fallbacks: ["opencode-go/kimi-k3", "gpt-6-sol"] };

const standingBy = {
  source: { status: "available" },
  fallbacks: [{ status: "available" }, { status: "available" }],
  serving: "gpt-6-astra",
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

          yield* via.put(
            "/admin/fallbacks",
            { model: "gpt-6-luna", fallbacks: ["gpt-6-sol"] },
            adminKey,
          );
          yield* via.put(
            "/admin/fallbacks",
            { model: "gpt-6-astra", fallbacks: ["gpt-6-sol"] },
            adminKey,
          );

          const listed = yield* (yield* via.get("/admin/fallbacks", adminKey)).json;
          expect(listed).toMatchObject([
            { model: "gpt-6-astra", fallbacks: ["gpt-6-sol"] },
            { model: "gpt-6-luna", fallbacks: ["gpt-6-sol"] },
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
            { model: "gpt-6-astra", fallbacks: ["gpt-6-astra"] },
            adminKey,
          );

          expect(itself.status).toBe(400);
          expect(
            yield* Schema.decodeUnknownEffect(FallbackRuleInvalidError)(yield* itself.json),
          ).toEqual(
            new FallbackRuleInvalidError({ problem: "gpt-6-astra can't fall back to itself" }),
          );
          expect(
            (yield* via.put("/admin/fallbacks", { model: "gpt-6-astra", fallbacks: [] }, adminKey))
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
          yield* via.put("/admin/fallbacks", { model, fallbacks: ["gpt-6-astra"] }, adminKey);

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
          yield* via.post("/v1/responses", { model: "gpt-6-sol", input: "hi" });
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
          yield* via.post("/v1/responses", { model: "gpt-6-sol", input: "hi" });
          yield* via.put(
            "/admin/fallbacks",
            { model: "gpt-6-astra", fallbacks: ["opencode-go/kimi-k3", "gpt-6-sol"] },
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
            { model: "gpt-6-astra", fallbacks: ["openrouter/a/b"] },
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

  it.effect("says a model via doesn't know can't answer", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.put(
            "/admin/fallbacks",
            { model: "gpt-nope", fallbacks: ["gpt-also-nope", "gpt-6-sol"] },
            adminKey,
          );

          const rules = yield* (yield* via.get("/admin/fallbacks", adminKey)).json;
          expect(rules).toMatchObject([
            {
              status: {
                source: { status: "unavailable", reason: "not_listed" },
                fallbacks: [
                  { status: "unavailable", reason: "not_listed" },
                  { status: "available" },
                ],
                serving: "gpt-6-sol",
              },
            },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("fails a request on a rules file it can't read, saying which file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const path = `${via.dir}/fallbacks.json`;
            yield* fs.writeFileString(path, "{ not json");

            for (const response of [
              yield* via.get("/admin/fallbacks", adminKey),
              yield* via.put("/admin/fallbacks", sol, adminKey),
              yield* via.delete("/admin/fallbacks?model=gpt-6-astra", adminKey),
            ]) {
              expect(response.status).toBe(500);
              expect(JSON.stringify(yield* response.json)).toContain(path);
            }
          }),
        { adminKey },
      );
    }),
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
