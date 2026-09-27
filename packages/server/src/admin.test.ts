import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { Clock, Effect, Fiber, Schedule, Schema } from "effect";
import { TestClock } from "effect/testing";
import type { HttpClientResponse } from "effect/unstable/http";
import { type Via, ok, withVia } from "./testing/harness.ts";
import { LoginNotFoundError } from "./admin-api.ts";

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
    const all = yield* Schema.decodeUnknownEffect(
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

/** Decodes `GET /admin/pool`'s answer: its accounts and providers, each with a state. */
const poolOf = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.flatMap(
    response.json,
    Schema.decodeUnknownEffect(
      Schema.Struct({
        accounts: Schema.Array(Schema.Json),
        opencodeGo: Schema.Array(Schema.Json),
        providers: Schema.Array(Schema.Json),
      }),
    ),
  );

/** Codex rate-limits account "a" for two minutes, and answers account "b" with a 401. */
const coolingAndUnauthorized = (request: CodexRequest) =>
  request.headers["chatgpt-account-id"] === "acc-a"
    ? reply.error(429, "", { "retry-after": "120" })
    : reply.error(401, "");

/** Codex rate-limits account "a" for two minutes, and answers account "b". */
const coolingA = (request: CodexRequest) =>
  request.headers["chatgpt-account-id"] === "acc-a"
    ? reply.error(429, "", { "retry-after": "120" })
    : ok();

/**
 * Runs `request`, moving the test clock on until it ends: via answers a wrong
 * admin key only after a delay, which the test clock would otherwise never end.
 */
const clocked = <A, E>(request: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(request);
    yield* TestClock.withLive(Effect.sleep("2 millis")).pipe(
      Effect.andThen(TestClock.adjust("1 second")),
      Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined }),
    );

    return yield* Fiber.join(fiber);
  });

/** The `/wham/usage` lookups the fake Codex received so far. */
const usageLookups = (via: Via) =>
  via.upstreamRequests.filter(({ path }) => path === "/wham/usage");

/** Runs `read` until `done` says so, a few real milliseconds apart: for a refresh running in the background. */
const eventually = <A, E>(read: Effect.Effect<A, E>, done: (value: A) => boolean) =>
  TestClock.withLive(Effect.sleep("5 millis")).pipe(
    Effect.andThen(read),
    Effect.repeat({ until: done, schedule: Schedule.recurs(400) }),
  );

/** `GET /admin/usage`'s answer once via is no longer asking for newer usage. */
const settledUsage = (via: Via) =>
  eventually(
    via.get("/admin/usage", adminKey).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.StructWithRest(Schema.Struct({ refreshing: Schema.Boolean }), [Schema.JsonObject]),
        ),
      ),
    ),
    ({ refreshing }) => !refreshing,
  );

/** The required fields of an object schema in an OpenAPI spec. */
const Required = Schema.Struct({ required: Schema.Array(Schema.String) });

/** What the spec says `GET /admin/usage` answers: the fields it and its entries require. */
const decodeUsageSpec = Schema.decodeUnknownSync(
  Schema.Struct({
    paths: Schema.Struct({
      "/admin/usage": Schema.Struct({
        get: Schema.Struct({
          responses: Schema.Struct({
            "200": Schema.Struct({
              content: Schema.Struct({
                "application/json": Schema.Struct({
                  schema: Schema.Struct({
                    required: Schema.Array(Schema.String),
                    properties: Schema.Struct({
                      accounts: Schema.Struct({
                        items: Schema.Struct({ anyOf: Schema.Array(Required) }),
                      }),
                      opencodeGo: Schema.Struct({
                        items: Schema.Struct({ anyOf: Schema.Array(Required) }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }),
);

/** Signs in to the admin API with `key`, as the admin UI does. */
const signIn = (via: Via, key: string, headers: Record<string, string> = {}) =>
  clocked(via.post("/admin/session", { key }, null, headers));

/** The attributes of the cookie a response sets, `name=value` first. */
const setCookie = (response: HttpClientResponse.HttpClientResponse) =>
  (response.headers["set-cookie"] ?? "").split("; ");

/** Signs in with the admin key, and answers the `Cookie` header that sends its session back. */
const sessionCookie = (via: Via) =>
  Effect.map(signIn(via, adminKey), (response) => setCookie(response)[0] ?? "");

/** What a request from the admin UI sends along with its session cookie. */
const fromTheUi = (via: Via, cookie: string) => ({
  cookie,
  origin: via.baseUrl,
  "x-via-csrf": "1",
});

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
            expect.arrayContaining([
              "/admin/accounts",
              "/admin/keys",
              "/admin/usage",
              "/admin/pool",
              "/admin/models",
            ]),
          );
          expect(Object.values(spec.components.securitySchemes)).toEqual([
            { type: "http", scheme: "bearer" },
            { type: "apiKey", name: "via_session", in: "cookie" },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("says in its spec when each usage report was fetched, and whether a refresh runs", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const spec = decodeUsageSpec(yield* (yield* via.get("/admin/openapi.json", null)).json);

          const usage =
            spec.paths["/admin/usage"].get.responses["200"].content["application/json"].schema;

          expect(usage.required).toEqual(["accounts", "opencodeGo", "refreshing"]);

          for (const entry of [
            ...usage.properties.accounts.items.anyOf,
            ...usage.properties.opencodeGo.items.anyOf,
          ]) {
            expect(entry.required).toContain("fetchedAt");
          }
        }),
      { adminKey },
    ),
  );

  it.effect("describes /admin/events in its spec as server-sent state events", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const spec = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              paths: Schema.Struct({
                "/admin/events": Schema.Struct({
                  get: Schema.Struct({
                    responses: Schema.Struct({
                      "200": Schema.Struct({
                        content: Schema.Record(Schema.String, Schema.Json),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          )(yield* (yield* via.get("/admin/openapi.json", null)).json);

          expect(Object.keys(spec.paths["/admin/events"].get.responses["200"].content)).toEqual([
            "text/event-stream",
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect(
    "serves an API reference page for the spec",
    () =>
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
    // The first request for the page loads Scalar's inlined script, which takes a
    // loaded CI runner longer than the default 5 s; the reference-page tests after it
    // are fast.
    30_000,
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

  it.effect("signs an account that is already in the pool in again, rather than adding it", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const first = yield* (yield* via.post("/admin/accounts/logins", {}, adminKey)).json;
          yield* settled(via, decodeLogin(first).id);
          const again = yield* (yield* via.post("/admin/accounts/logins", {}, adminKey)).json;
          const dev = { ...account("dev"), label: "dev@example.com", email: "dev@example.com" };

          expect(yield* settled(via, decodeLogin(again).id)).toEqual({
            status: "updated",
            account: dev,
          });
          expect(yield* (yield* via.get("/admin/accounts", adminKey)).json).toEqual([
            account("a"),
            account("b"),
            dev,
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect(
    "puts an account locked out by a rejected refresh back in rotation once it signs in again",
    () => {
      let rejected = false;

      return withVia(
        (request) => {
          if (request.headers["chatgpt-account-id"] !== "acc-123" || rejected) return ok();
          rejected = true;

          return reply.error(401, "");
        },
        (via) =>
          Effect.gen(function* () {
            const login = () =>
              Effect.flatMap(via.post("/admin/accounts/logins", {}, adminKey), (started) =>
                Effect.flatMap(started.json, (json) => settled(via, decodeLogin(json).id)),
              );

            yield* login();

            for (const name of ["a", "b"]) {
              yield* via.patch(
                `/admin/accounts/${yield* accountId(via, name)}`,
                { enabled: false },
                adminKey,
              );
            }

            const request = { model: "gpt-5.1-codex", input: "hi" };
            expect((yield* via.post("/v1/responses", request)).status).not.toBe(200);
            const locked = (yield* poolOf(yield* via.get("/admin/pool", adminKey))).accounts;

            expect(locked).toContainEqual(
              expect.objectContaining({
                label: "dev@example.com",
                state: expect.objectContaining({ status: "auth_error" }),
              }),
            );
            expect(yield* login()).toMatchObject({ status: "updated" });
            expect((yield* via.post("/v1/responses", request)).status).toBe(200);
            expect(via.upstreamRequests.map((r) => r.headers["chatgpt-account-id"])).toEqual([
              "acc-123",
              "acc-123",
            ]);
          }),
        { adminKey, refreshResponse: { status: 400, body: { error: "invalid_grant" } } },
      );
    },
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
          const response = yield* via.get("/admin/accounts/logins/nope", adminKey);
          expect(response.status).toBe(404);
          const error = yield* Schema.decodeUnknownEffect(LoginNotFoundError)(yield* response.json);
          expect(error.id).toBe("nope");
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
            {
              id: expect.any(String),
              name: "test",
              createdAt: expect.any(String),
              lastUsedAt: null,
            },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("lists when a client key was last used on /v1", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("1 hour");
          yield* via.get("/v1/models");
          const usedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* TestClock.adjust("5 minutes");

          expect(yield* (yield* via.get("/admin/keys", adminKey)).json).toEqual([
            expect.objectContaining({ name: "test", lastUsedAt: usedAt }),
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

  it.effect("answers at once before it has any usage, asking for it in the background", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get("/admin/usage", adminKey);
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual({ accounts: [], opencodeGo: [], refreshing: true });
          yield* eventually(
            Effect.sync(() => usageLookups(via).length),
            (lookups) => lookups === 2,
          );
        }),
      { adminKey },
    ),
  );

  it.effect("reports every ChatGPT and OpenCode Go account's usage, or why it is unavailable", () =>
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
          const fetchedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          expect(yield* settledUsage(via)).toEqual({
            accounts: [
              {
                id: expect.any(String),
                label: "a@example.com",
                fetchedAt,
                windows: [
                  { windowMinutes: 300, usedPercent: 12, resetsAt: "2023-11-14T23:13:20.000Z" },
                  { windowMinutes: 10_080, usedPercent: 40, resetsAt: "2023-11-15T22:13:20.000Z" },
                ],
              },
              {
                id: expect.any(String),
                label: "b@example.com",
                fetchedAt,
                error: "ChatGPT did not report usage (HTTP 403)",
              },
            ],
            opencodeGo: [
              {
                id: expect.any(String),
                label: "go-1",
                fetchedAt,
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
            refreshing: false,
          });
        }),
      { adminKey },
    ),
  );

  it.effect("shows each account's pool state: cooling until when and why, or locked out", () =>
    withVia(
      coolingAndUnauthorized,
      (via) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* via.post("/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
          const response = yield* via.get("/admin/pool", adminKey);
          expect(response.status).toBe(200);
          expect((yield* poolOf(response)).accounts).toEqual([
            {
              id: expect.any(String),
              label: "a@example.com",
              enabled: true,
              state: {
                status: "cooling",
                until: new Date(now + 120_000).toISOString(),
                reason: expect.any(String),
              },
            },
            {
              id: expect.any(String),
              label: "b@example.com",
              enabled: true,
              state: { status: "auth_error", reason: "unauthorized" },
            },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("shows an account whose cooldown has run out as available", () =>
    withVia(
      coolingA,
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
          yield* TestClock.adjust("2 minutes");
          expect((yield* poolOf(yield* via.get("/admin/pool", adminKey))).accounts).toEqual([
            {
              id: expect.any(String),
              label: "a@example.com",
              enabled: true,
              state: { status: "available" },
            },
            {
              id: expect.any(String),
              label: "b@example.com",
              enabled: true,
              state: { status: "available" },
            },
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("shows a disabled account in the pool as disabled", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.patch(
            `/admin/accounts/${yield* accountId(via, "a")}`,
            { enabled: false },
            adminKey,
          );
          const pool = yield* poolOf(yield* via.get("/admin/pool", adminKey));
          expect(pool.accounts).toEqual([
            expect.objectContaining({ label: "a@example.com", enabled: false }),
            expect.objectContaining({ label: "b@example.com", enabled: true }),
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("shows each configured provider with its own key next to the accounts", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const pool = yield* poolOf(yield* via.get("/admin/pool", adminKey));
          expect(pool.providers).toEqual([{ name: "openrouter", state: { status: "available" } }]);
        }),
      { adminKey },
    ),
  );

  it.effect("shows each OpenCode Go account's pool state, cooling while rate limited", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          via.provider.respond(
            providerReply.byKey({
              "sk-provider": providerReply.rateLimited({ "retry-after": "60" }),
              "sk-provider-2": providerReply.json({ id: "resp_go" }),
            }),
          );
          yield* via.post("/v1/responses", { model: "opencode-go/kimi-k3", input: "hi" });
          const pool = yield* poolOf(yield* via.get("/admin/pool", adminKey));
          expect(pool.opencodeGo).toEqual([
            {
              id: expect.any(String),
              label: "go-1",
              enabled: true,
              state: {
                status: "cooling",
                until: new Date(now + 60_000).toISOString(),
                reason: "rate_limited",
              },
            },
            {
              id: expect.any(String),
              label: "go-2",
              enabled: true,
              state: { status: "available" },
            },
          ]);
        }),
      { adminKey, opencodeGoKeys: ["sk-provider", "sk-provider-2"] },
    ),
  );

  it.effect("answers usage it already has without asking ChatGPT again", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const first = yield* settledUsage(via);
          yield* TestClock.adjust("59 seconds");
          expect(yield* (yield* via.get("/admin/usage", adminKey)).json).toEqual(first);
          expect(usageLookups(via)).toHaveLength(2);
        }),
      { adminKey },
    ),
  );

  it.effect("answers usage a minute old at once, and asks for new usage in the background", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const first = yield* settledUsage(via);
          yield* TestClock.adjust("1 minute");
          expect(yield* (yield* via.get("/admin/usage", adminKey)).json).toEqual({
            ...first,
            refreshing: true,
          });

          const now = new Date(yield* Clock.currentTimeMillis).toISOString();
          expect(JSON.stringify(yield* settledUsage(via))).toContain(now);
          expect(usageLookups(via)).toHaveLength(4);
        }),
      { adminKey },
    ),
  );

  it.effect(
    "asks OpenCode Go for an account's usage at most once a minute, however often usage is read",
    () =>
      withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            via.provider.usage({ usage: {} });
            yield* via.get("/admin/pool", adminKey);
            yield* settledUsage(via);

            for (let read = 0; read < 6; read++) {
              yield* via.get("/admin/pool", adminKey);
              yield* via.get("/admin/usage", adminKey);
              yield* TestClock.adjust("9 seconds");
            }

            expect(via.provider.usageRequests).toHaveLength(1);

            yield* TestClock.adjust("6 seconds");
            yield* via.get("/admin/usage", adminKey);
            yield* eventually(
              Effect.sync(() => via.provider.usageRequests.length),
              (requests) => requests === 2,
            );
          }),
        { adminKey },
      ),
  );

  it.effect("lists the models /v1/models lists", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get("/admin/models", adminKey);
          expect(response.status).toBe(200);

          const listed = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ data: Schema.Array(Schema.Json) }),
          )(yield* (yield* via.get("/v1/models")).json);

          const models = yield* response.json;
          expect(models).toEqual(listed.data);
          expect(models).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "gpt-6-astra", owned_by: "openai" }),
            ]),
          );
        }),
      { adminKey },
    ),
  );

  it.effect("keeps the pool and the models behind the admin key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/pool", null)).status).toBe(401);
          expect((yield* via.get("/admin/models")).status).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("signs in with the admin key, setting a session cookie scripts can't read", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* signIn(via, adminKey);
          expect(response.status).toBe(204);
          const [pair, ...attributes] = setCookie(response);
          expect(pair).toMatch(/^via_session=[\w-]{43}$/);
          expect(attributes.toSorted()).toEqual([
            "HttpOnly",
            "Max-Age=43200",
            "Path=/",
            "SameSite=Strict",
          ]);
        }),
      { adminKey },
    ),
  );

  it.effect("marks the session cookie Secure when the browser signs in over HTTPS", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* signIn(via, adminKey, { origin: "https://via.example.com" });
          expect(setCookie(response)).toContain("Secure");
        }),
      { adminKey },
    ),
  );

  it.effect("refuses a wrong admin key, and logs the failure without it", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* signIn(via, "wrong-key-with-a-guess-in-it");
          expect(response.status).toBe(401);
          expect(response.headers["set-cookie"]).toBeUndefined();
          yield* via.logged("Failed admin sign-in");
          expect(JSON.stringify(via.logs)).not.toContain("wrong-key-with-a-guess-in-it");
        }),
      { adminKey },
    ),
  );

  it.effect("refuses every sign-in for a while after ten wrong keys in a minute", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const wrong = yield* clocked(
            Effect.forEach(
              Array.from({ length: 10 }),
              () => via.post("/admin/session", { key: "wrong" }, null),
              { concurrency: "unbounded" },
            ),
          );

          expect(wrong.map(({ status }) => status)).toEqual(Array.from({ length: 10 }, () => 401));
          expect((yield* signIn(via, adminKey)).status).toBe(429);
          yield* TestClock.adjust("1 minute");
          expect((yield* signIn(via, adminKey)).status).toBe(204);
        }),
      { adminKey },
    ),
  );

  it.effect("lets a session cookie in where the admin key goes", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/session", null)).status).toBe(401);
          const cookie = yield* sessionCookie(via);
          expect((yield* via.get("/admin/session", null, { cookie })).status).toBe(200);
          expect((yield* via.get("/admin/session", adminKey)).status).toBe(200);
          const accounts = yield* via.get("/admin/accounts", null, { cookie });
          expect(accounts.status).toBe(200);
          expect(yield* accounts.json).toEqual([account("a"), account("b")]);
          expect(
            (yield* via.get("/admin/accounts", null, { cookie: "via_session=made-up" })).status,
          ).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("finds the live session among stale ones a browser still sends", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          // A browser that signed in before the cookie's path widened from /admin to /
          // keeps that old cookie, and sends it first to /admin: the more specific path.
          const cookie = `via_session=from-before; ${yield* sessionCookie(via)}`;
          expect((yield* via.get("/admin/session", null, { cookie })).status).toBe(200);
          expect((yield* via.get("/admin/accounts", null, { cookie })).status).toBe(200);
          expect(
            (yield* via.patch(
              `/admin/accounts/${yield* accountId(via, "a")}`,
              { label: "work" },
              null,
              fromTheUi(via, cookie),
            )).status,
          ).toBe(200);
        }),
      { adminKey },
    ),
  );

  it.effect("deletes a session cookie that no longer signs in, and the one from before /", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          // Every Set-Cookie of the answer: an HttpClient response keeps only one per name.
          const expired = (cookie?: string) =>
            Effect.promise(() =>
              fetch(`${via.baseUrl}/admin/session`, {
                headers: cookie === undefined ? {} : { cookie },
              }),
            ).pipe(
              Effect.map((response) => {
                const sets = response.headers.getSetCookie();

                return {
                  status: response.status,
                  root: sets.some((set) => set.startsWith("via_session=; Max-Age=0; Path=/;")),
                  admin: sets.some((set) =>
                    set.startsWith("via_session=; Max-Age=0; Path=/admin;"),
                  ),
                };
              }),
            );

          // A session that ended (or a via that restarted) leaves a dead cookie behind.
          expect(yield* expired("via_session=ended")).toEqual({
            status: 401,
            root: true,
            admin: true,
          });

          // A live session keeps its cookie; only the one from the old /admin path goes.
          const cookie = `via_session=ended; ${yield* sessionCookie(via)}`;
          expect(yield* expired(cookie)).toEqual({ status: 200, root: false, admin: true });

          // No session cookie at all: nothing to delete.
          expect(yield* expired()).toEqual({ status: 401, root: false, admin: false });

          // Signing in while a dead cookie is still sent keeps the new session's cookie.
          const signedIn = yield* Effect.promise(() =>
            fetch(`${via.baseUrl}/admin/session`, {
              method: "POST",
              headers: {
                cookie: "via_session=ended",
                "content-type": "application/json",
                origin: via.baseUrl,
              },
              body: JSON.stringify({ key: adminKey }),
            }),
          );

          const sets = signedIn.headers.getSetCookie();
          expect(signedIn.status).toBe(204);
          expect(sets.some((set) => /^via_session=[^;]+; Max-Age=43200; Path=\/;/.test(set))).toBe(
            true,
          );
          expect(sets.some((set) => set.startsWith("via_session=; Max-Age=0; Path=/;"))).toBe(
            false,
          );
        }),
      { adminKey },
    ),
  );

  it.effect("takes a change on a session cookie only from via's own origin with x-via-csrf", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const path = `/admin/accounts/${yield* accountId(via, "a")}`;
          const cookie = yield* sessionCookie(via);
          const change = { label: "work" };

          const refused: ReadonlyArray<Record<string, string>> = [
            { cookie },
            { cookie, "x-via-csrf": "1" },
            { cookie, origin: via.baseUrl },
            { cookie, origin: "https://evil.example.com", "x-via-csrf": "1" },
            { cookie, origin: via.baseUrl, "x-via-csrf": "0" },
          ];

          for (const headers of refused) {
            expect((yield* via.patch(path, change, null, headers)).status).toBe(403);
            expect((yield* via.delete(path, null, headers)).status).toBe(403);
          }

          expect(yield* (yield* via.get("/admin/accounts", adminKey)).json).toEqual([
            account("a"),
            account("b"),
          ]);
          const changed = yield* via.patch(path, change, null, fromTheUi(via, cookie));
          expect(changed.status).toBe(200);
          expect(yield* changed.json).toEqual({ ...account("a"), label: "work" });
        }),
      { adminKey },
    ),
  );

  it.effect("signs out, ending the session and expiring its cookie", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const cookie = yield* sessionCookie(via);
          const response = yield* via.delete("/admin/session", null, fromTheUi(via, cookie));
          expect(response.status).toBe(204);
          expect(setCookie(response)).toEqual(
            expect.arrayContaining(["via_session=", "Max-Age=0"]),
          );
          expect((yield* via.get("/admin/session", null, { cookie })).status).toBe(401);
        }),
      { adminKey },
    ),
  );

  it.effect("logs neither the admin key nor a session cookie", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const cookie = yield* sessionCookie(via);
          yield* via.get("/admin/accounts", null, { cookie });
          yield* via.delete("/admin/session", null, fromTheUi(via, cookie));
          yield* via.logged("DELETE");
          const logs = JSON.stringify(via.logs);
          expect(logs).toContain("/admin/session");
          expect(logs).not.toContain(adminKey);
          expect(logs).not.toContain(cookie.slice("via_session=".length));
        }),
      { adminKey },
    ),
  );

  it.effect("has no sign-in without VIA_ADMIN_KEY", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        expect((yield* via.post("/admin/session", { key: adminKey }, null)).status).toBe(404);
      }),
    ),
  );
});
