import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { ok, type Via, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

const Listed = Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }));

/** The OpenCode Go accounts as `GET /admin/opencode-go/accounts` lists them. */
const listed = (via: Via) =>
  via
    .get("/admin/opencode-go/accounts", adminKey)
    .pipe(Effect.flatMap((response) => response.json));

/** The id of the OpenCode Go account labelled `label`. */
const idOf = (via: Via, label: string) =>
  Effect.gen(function* () {
    const all = yield* Schema.decodeUnknownEffect(Listed)(yield* listed(via));

    return all.find((account) => account.label === label)?.id ?? "";
  });

const add = (via: Via, body: Schema.Json) =>
  via.post("/admin/opencode-go/accounts", body, adminKey);

layer(BunFileSystem.layer)("admin API, OpenCode Go accounts", (it) => {
  it.effect("lists OpenCode Go accounts with only their key's last four characters", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const body = yield* listed(via);
          expect(body).toEqual([
            {
              id: expect.any(String),
              label: "go-1",
              key: "…1234",
              enabled: true,
              createdAt: expect.any(String),
            },
          ]);
          expect(JSON.stringify(body)).not.toContain("sk-go");
        }),
      { adminKey, opencodeGoKeys: ["sk-go-1234"] },
    ),
  );

  it.effect("notes the account whose key the deprecated variable still holds", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect(yield* listed(via)).toEqual([
            expect.objectContaining({ label: "go-1", environmentVariable: "OPENCODE_API_KEY" }),
            expect.not.objectContaining({ environmentVariable: expect.anything() }),
          ]);
        }),
      {
        adminKey,
        opencodeGoKeys: ["sk-env", "sk-other"],
        opencodeGoVariable: { variable: "OPENCODE_API_KEY", apiKey: "sk-env" },
      },
    ),
  );

  it.effect("adds a key once OpenCode Go accepts it, and pools it at once", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.usageFor("sk-new-5678", { usage: {} });
          via.provider.respond((request) => ({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ key: request.headers["authorization"] }),
          }));

          const response = yield* add(via, { apiKey: "sk-new-5678", label: "work" });
          expect(response.status).toBe(201);
          expect(yield* response.json).toEqual({
            id: expect.any(String),
            label: "work",
            key: "…5678",
            enabled: true,
            createdAt: expect.any(String),
          });
          expect(via.provider.usageRequests.at(-1)?.headers["authorization"]).toBe(
            "Bearer sk-new-5678",
          );

          const served = yield* via.post("/v1/responses", {
            model: "opencode-go/kimi-k3",
            input: "hi",
          });

          expect(yield* served.json).toEqual({ key: "Bearer sk-new-5678" });
        }),
      { adminKey, opencodeGoKeys: [] },
    ),
  );

  it.effect("refuses a key OpenCode Go refuses, saying so, and stores nothing", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.usageFor("sk-wrong", { error: "unauthorized" }, 401);
          const response = yield* add(via, { apiKey: "sk-wrong" });
          expect(response.status).toBe(422);
          expect(yield* response.json).toMatchObject({ status: 401 });
          expect(yield* listed(via)).toEqual([]);
        }),
      { adminKey, opencodeGoKeys: [] },
    ),
  );

  it.effect("answers 502 when OpenCode Go can't check the key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          // The fake answers its usage endpoint with a 500 until told otherwise.
          const response = yield* add(via, { apiKey: "sk-unchecked" });
          expect(response.status).toBe(502);
          expect(yield* listed(via)).toEqual([]);
        }),
      { adminKey, opencodeGoKeys: [] },
    ),
  );

  it.effect("refuses a key it already stores", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.usage({ usage: {} });
          const response = yield* add(via, { apiKey: "sk-go-1234" });
          expect(response.status).toBe(409);
          expect(yield* response.json).toMatchObject({ label: "go-1" });
        }),
      { adminKey, opencodeGoKeys: ["sk-go-1234"] },
    ),
  );

  it.effect("renames, disables and removes an account by id", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const id = yield* idOf(via, "go-1");
          const path = `/admin/opencode-go/accounts/${id}`;

          const renamed = yield* via.patch(path, { label: "work", enabled: false }, adminKey);
          expect(yield* renamed.json).toMatchObject({ id, label: "work", enabled: false });
          expect(
            (yield* via.post("/v1/responses", { model: "opencode-go/m", input: "hi" })).status,
          ).toBe(503);

          expect((yield* via.delete(path, adminKey)).status).toBe(204);
          expect(yield* listed(via)).toEqual([]);
        }),
      { adminKey },
    ),
  );

  it.effect("answers 404 for an account it doesn't have, even by its label", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.patch("/admin/opencode-go/accounts/go-1", {}, adminKey)).status).toBe(
            404,
          );
          expect((yield* via.delete("/admin/opencode-go/accounts/nope", adminKey)).status).toBe(
            404,
          );
        }),
      { adminKey },
    ),
  );

  it.effect("needs the admin key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/opencode-go/accounts", null)).status).toBe(401);
          expect(
            (yield* via.post("/admin/opencode-go/accounts", { apiKey: "k" }, null)).status,
          ).toBe(401);
        }),
      { adminKey },
    ),
  );
});
