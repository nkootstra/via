import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply } from "@via/providers/testing";
import { Effect, Schema } from "effect";
import { ok, type Via, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

/** The JSON answer to `GET path` with the admin key, and its status. */
const read = (via: Via, path: string) =>
  Effect.gen(function* () {
    const response = yield* via.get(path, adminKey);

    return { status: response.status, body: yield* response.json };
  });

const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** The ids of the models via lists. */
const modelIds = (via: Via) =>
  Effect.gen(function* () {
    const { data } = yield* Schema.decodeUnknownEffect(Models)(
      yield* (yield* via.get("/v1/models")).json,
    );

    return data.map(({ id }) => id);
  });

layer(BunFileSystem.layer)("admin API, Ollama", (it) => {
  it.effect("has no Ollama until one is saved", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect(yield* read(via, "/admin/ollama")).toEqual({ status: 200, body: null });
        }),
      { adminKey },
    ),
  );

  it.effect("checks an address: Ollama's version there and its models", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.ollama("0.35.0");
          via.provider.models(["nimble", "llama3.2"]);

          const response = yield* via.post(
            "/admin/ollama/check",
            { address: `${via.provider.url}/v1/` },
            adminKey,
          );

          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual({
            address: via.provider.url,
            version: "0.35.0",
            models: ["nimble", "llama3.2"],
          });
        }),
      { adminKey },
    ),
  );

  it.effect("says why an address can't be used", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const invalid = yield* via.post(
            "/admin/ollama/check",
            { address: "ftp://nas" },
            adminKey,
          );

          expect(invalid.status).toBe(400);
          expect(yield* invalid.json).toMatchObject({ address: "ftp://nas" });

          const unreachable = yield* via.post(
            "/admin/ollama/check",
            { address: "http://127.0.0.1:1" },
            adminKey,
          );

          expect(unreachable.status).toBe(422);
          expect(yield* unreachable.json).toMatchObject({ reason: "nothing answered there" });
        }),
      { adminKey },
    ),
  );

  it.effect("sends to a saved Ollama at once, and no more once it is removed", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.models(["nimble"]);
          via.provider.respond(providerReply.json({ id: "chatcmpl-ollama" }));

          const saved = yield* via.put(
            "/admin/ollama",
            { address: ` ${via.provider.url} ` },
            adminKey,
          );

          expect(saved.status).toBe(200);
          expect(yield* saved.json).toEqual({ address: via.provider.url, fromConfig: false });
          expect((yield* read(via, "/admin/ollama")).body).toEqual({
            address: via.provider.url,
            fromConfig: false,
          });
          expect(yield* modelIds(via)).toContain("ollama/nimble");

          const chat = yield* via.post("/v1/chat/completions", {
            model: "ollama/nimble",
            messages: [],
          });

          expect(yield* chat.json).toEqual({ id: "chatcmpl-ollama" });

          expect((yield* via.delete("/admin/ollama", adminKey)).status).toBe(204);
          expect((yield* read(via, "/admin/ollama")).body).toBeNull();
          expect(yield* modelIds(via)).not.toContain("ollama/nimble");
        }),
      { adminKey },
    ),
  );

  it.effect("shows config.yaml's Ollama, and leaves it to config.yaml", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* read(via, "/admin/ollama")).body).toEqual({
            address: via.provider.url,
            fromConfig: true,
          });

          const saved = yield* via.put("/admin/ollama", { address: "http://nas:11434" }, adminKey);
          expect(saved.status).toBe(409);
          expect((yield* via.delete("/admin/ollama", adminKey)).status).toBe(409);
        }),
      { adminKey, ollama: true },
    ),
  );
});
