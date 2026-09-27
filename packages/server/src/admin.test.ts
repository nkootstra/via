import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream, reply } from "@via/codex-upstream/testing";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { type Via, withVia } from "./harness.ts";

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

/** Decodes a started login, as `POST /admin/accounts/logins` answers it. */
const decodeLogin = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));

/** The parts of an OpenAPI spec the tests look at. */
const decodeSpec = Schema.decodeUnknownSync(
  Schema.Struct({
    paths: Schema.Record(Schema.String, Schema.Json),
    components: Schema.Struct({ securitySchemes: Schema.Record(Schema.String, Schema.Json) }),
  }),
);

/** The id of account `name` from the harness, as the admin API lists it. */
const accountId = (via: Via, name: string) =>
  Effect.gen(function* () {
    const all = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ id: Schema.String, email: Schema.String })),
    )(yield* (yield* via.get("/admin/accounts", adminKey)).json);

    return all.find(({ email }) => email === `${name}@example.com`)?.id ?? "";
  });

/** Polls a login, a minute of test time apart, until it is no longer pending. */
const settled = (via: Via, id: string) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");

    return yield* (yield* via.get(`/admin/accounts/logins/${id}`, adminKey)).json;
  }).pipe(
    Effect.repeat({
      until: (login) => !Schema.is(Schema.Struct({ status: Schema.Literal("pending") }))(login),
    }),
  );

layer(BunFileSystem.layer)("admin API", (it) => {
  it.effect("does not exist without VIA_ADMIN_KEY", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        expect((yield* via.get("/admin/accounts", adminKey)).status).toBe(404);
      }),
    ),
  );

  it.effect("publishes its OpenAPI spec with a lowercase bearer scheme without the admin key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get("/admin/openapi.json", null);
          expect(response.status).toBe(200);
          const spec = decodeSpec(yield* response.json);
          expect(Object.keys(spec.paths)).toEqual(
            expect.arrayContaining(["/admin/accounts", "/admin/keys", "/admin/usage"]),
          );
          expect(Object.values(spec.components.securitySchemes)).toEqual([
            { type: "http", scheme: "bearer" },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("serves an API reference page for the spec", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get("/admin/docs", null);
          expect(response.status).toBe(200);
          expect(response.headers["content-type"]).toMatch(/^text\/html/);
        }),
      { adminKey },
    ),
  );

  it.effect("keeps the reference page to system fonts instead of Scalar's web fonts", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const page = yield* (yield* via.get("/admin/docs", null)).text;
          expect(page).toContain(`"withDefaultFonts":false`);
        }),
      { adminKey },
    ),
  );

  it.effect("hides the reference page's Open API Client button", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const page = yield* (yield* via.get("/admin/docs", null)).text;
          expect(page).toContain(`"hideClientButton":true`);
        }),
      { adminKey },
    ),
  );

  it.effect("hides the reference page's developer tools", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const page = yield* (yield* via.get("/admin/docs", null)).text;
          expect(page).toContain(`"showDeveloperTools":"never"`);
        }),
      { adminKey },
    ),
  );

  it.effect("has no spec or reference page without VIA_ADMIN_KEY", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        expect((yield* via.get("/admin/openapi.json", null)).status).toBe(404);
        expect((yield* via.get("/admin/docs", null)).status).toBe(404);
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

  it.effect("renames and disables an account", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.patch(
            `/admin/accounts/${yield* accountId(via, "a")}`,
            { label: "work", enabled: false },
            adminKey,
          );

          expect(response.status).toBe(200);
          const changed = { ...account("a"), label: "work", enabled: false };
          expect(yield* response.json).toEqual(changed);
          expect(yield* (yield* via.get("/admin/accounts", adminKey)).json).toEqual([
            changed,
            account("b"),
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("changes only what the request names", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const path = `/admin/accounts/${yield* accountId(via, "a")}`;
          yield* via.patch(path, { enabled: false }, adminKey);
          const response = yield* via.patch(path, {}, adminKey);
          expect(yield* response.json).toEqual({ ...account("a"), enabled: false });
        }),
      { adminKey },
    ),
  );

  it.effect("stops using a disabled account", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.patch(
            `/admin/accounts/${yield* accountId(via, "a")}`,
            { enabled: false },
            adminKey,
          );
          yield* via.post("/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
          expect(via.upstreamRequests.map(({ headers }) => headers["chatgpt-account-id"])).toEqual([
            "acc-b",
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("removes an account", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const path = `/admin/accounts/${yield* accountId(via, "a")}`;
          expect((yield* via.delete(path, adminKey)).status).toBe(204);
          expect(yield* (yield* via.get("/admin/accounts", adminKey)).json).toEqual([account("b")]);
        }),
      { adminKey },
    ),
  );

  it.effect("finds an account by id only, keeping emails out of URLs", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          for (const path of ["/admin/accounts/a@example.com", "/admin/accounts/b@example.com"]) {
            expect((yield* via.patch(path, { enabled: false }, adminKey)).status).toBe(404);
            expect((yield* via.delete(path, adminKey)).status).toBe(404);
          }

          expect(yield* (yield* via.get("/admin/accounts", adminKey)).json).toEqual([
            account("a"),
            account("b"),
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("answers 404 for an account that does not exist", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect(
            (yield* via.patch("/admin/accounts/nobody", { label: "x" }, adminKey)).status,
          ).toBe(404);
          expect((yield* via.delete("/admin/accounts/nobody", adminKey)).status).toBe(404);
        }),
      { adminKey },
    ),
  );

  it.effect("starts a device-code login that waits for approval", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const started = yield* via.post("/admin/accounts/logins", {}, adminKey);
          expect(started.status).toBe(201);
          const login = yield* started.json;
          expect(login).toEqual({
            id: expect.any(String),
            userCode: "ABCD-1234",
            verificationUrl: expect.stringMatching(/\/codex\/device$/),
          });

          const response = yield* via.get(
            `/admin/accounts/logins/${decodeLogin(login).id}`,
            adminKey,
          );

          expect(yield* response.json).toEqual({ status: "pending" });
        }),
      { adminKey, pendingPolls: Infinity, interval: "5" },
    ),
  );

  it.effect("adds the account once the login is approved", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const login = yield* (yield* via.post("/admin/accounts/logins", {}, adminKey)).json;

          const added = {
            ...account("dev"),
            label: "dev@example.com",
            email: "dev@example.com",
          };

          expect(yield* settled(via, decodeLogin(login).id)).toEqual({
            status: "added",
            account: added,
          });
          expect(yield* (yield* via.get("/admin/accounts", adminKey)).json).toEqual([
            account("a"),
            account("b"),
            added,
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("fails a login that is not approved in time", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const login = yield* (yield* via.post("/admin/accounts/logins", {}, adminKey)).json;
          expect(yield* settled(via, decodeLogin(login).id)).toEqual({
            status: "failed",
            error: expect.stringContaining("not approved"),
          });
        }),
      { adminKey, pendingPolls: Infinity, interval: "5" },
    ),
  );

  it.effect("answers 404 for a login that does not exist", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/accounts/logins/nope", adminKey)).status).toBe(404);
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

  it.effect("reports every account's and provider's usage, or why it is unavailable", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.codexUsage("acc-b", {}, 403);
          via.provider.usage({
            usage: {
              rolling: { status: "ok", percent: 0, resetsAt: "2026-09-26T23:40:07.697Z" },
              weekly: { status: "ok", percent: 26, resetsAt: "2026-09-28T00:00:00.000Z" },
            },
          });
          const response = yield* via.get("/admin/usage", adminKey);
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual({
            accounts: [
              {
                id: expect.any(String),
                label: "a@example.com",
                windows: [
                  { windowMinutes: 300, usedPercent: 12, resetsAt: "2023-11-14T23:13:20.000Z" },
                  { windowMinutes: 10_080, usedPercent: 40, resetsAt: "2023-11-15T22:13:20.000Z" },
                ],
              },
              {
                id: expect.any(String),
                label: "b@example.com",
                error: "ChatGPT did not report usage (HTTP 403)",
              },
            ],
            providers: [
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
                ],
              },
            ],
          });
        }),
      { adminKey },
    ),
  );
});
