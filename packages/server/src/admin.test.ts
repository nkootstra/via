import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream, reply } from "@via/codex-upstream/testing";
import { Effect, Schema } from "effect";
import { withVia } from "./harness.ts";

const ok = () => reply.sse(completedStream("hello"));
const adminKey = "admin-key-that-is-long-enough-000";

/** Account `name` from the harness, as the admin API shows it. */
const account = (name: string) => ({
  id: expect.any(String),
  label: `${name}@example.com`,
  email: `${name}@example.com`,
  plan: "pro",
  enabled: true,
  createdAt: expect.any(String),
});

layer(BunFileSystem.layer)("admin API", (it) => {
  it.effect("does not exist without VIA_ADMIN_KEY", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        expect((yield* via.get("/admin/accounts", adminKey)).status).toBe(404);
      }),
    ),
  );

  it.effect("refuses a request without the admin key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/accounts", null)).status).toBe(401);
          expect((yield* via.get("/admin/accounts", "wrong")).status).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("refuses a client API key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/accounts")).status).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("does not accept the admin key as a client API key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/v1/models", adminKey)).status).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("refuses to start with an admin key shorter than 32 characters", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(withVia(ok, () => Effect.void, { adminKey: "short" }));
      expect(String(error)).toMatch(/VIA_ADMIN_KEY.*32 characters/);
    }),
  );

  it.effect("lists the accounts in the order they are used, without their tokens", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get("/admin/accounts", adminKey);
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual([account("a"), account("b")]);
        }),
      { adminKey },
    ),
  );

  it.effect("lists client keys without the keys themselves", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get("/admin/keys", adminKey);
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual([
            { id: expect.any(String), name: "test", createdAt: expect.any(String) },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("creates a client key, shown once, that works on /v1", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/admin/keys", { name: "laptop" }, adminKey);
          expect(response.status).toBe(201);
          const created = yield* response.json;
          expect(created).toEqual({
            id: expect.any(String),
            name: "laptop",
            key: expect.stringMatching(/^via_/),
          });
          const { key } = yield* Schema.decodeUnknownEffect(Schema.Struct({ key: Schema.String }))(
            created,
          );
          expect((yield* via.get("/v1/models", key)).status).toBe(200);
        }),
      { adminKey },
    ),
  );

  it.effect("refuses a second key with the same name", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/admin/keys", { name: "test" }, adminKey);
          expect(response.status).toBe(409);
        }),
      { adminKey },
    ),
  );

  it.effect("revokes a client key by name, after which it stops working", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.delete("/admin/keys/test", adminKey)).status).toBe(204);
          expect((yield* via.get("/v1/models")).status).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("revokes a client key by id", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const [{ id }] = yield* Schema.decodeUnknownEffect(
            Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
          )(yield* (yield* via.get("/admin/keys", adminKey)).json);
          expect((yield* via.delete(`/admin/keys/${id}`, adminKey)).status).toBe(204);
          expect((yield* via.get("/v1/models")).status).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("answers 404 when revoking a key that does not exist", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.delete("/admin/keys/nope", adminKey)).status).toBe(404);
        }),
      { adminKey },
    ),
  );
});
