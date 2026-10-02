import { BunFileSystem } from "@effect/platform-bun";
import { refreshedTokens } from "@via/codex-auth/testing";
import {
  type CodexRequest,
  codexFixture,
  completedStream,
  reply,
  sse,
} from "@via/codex-upstream/testing";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const accountOf = (request: CodexRequest) => request.headers["chatgpt-account-id"];

const usageLimit = (resetsAt: number) =>
  reply.error(429, { error: { type: "usage_limit_reached", resets_at: resetsAt } });

const request = { model: "gpt-6-astra", input: "hi" };

layer(BunFileSystem.layer)("POST /v1/responses", (it) => {
  it.effect("rejects a request without an API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", request, null);
        expect(response.status).toBe(401);
        expect(yield* response.json).toMatchObject({
          error: { code: "invalid_api_key" },
        });
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects an unknown API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", request, "via_wrong");
        expect(response.status).toBe(401);
      }),
    ),
  );

  it.effect("accepts the Bearer scheme in any case, as HTTP auth schemes are", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          fetch(`${via.baseUrl}/v1/responses`, {
            method: "POST",
            headers: { authorization: `bearer ${via.key}`, "content-type": "application/json" },
            body: JSON.stringify(request),
          }),
        );

        expect(response.status).toBe(200);
      }),
    ),
  );

  it.effect("streams the upstream events to a streaming client", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", {
          ...request,
          stream: true,
        });

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        expect(yield* response.text).toBe(completedStream("hello"));
      }),
    ),
  );

  it.effect("answers a non-streaming client with the completed response as JSON", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", request);
        expect(response.status).toBe(200);
        expect(yield* response.json).toMatchObject({
          id: "resp_1",
          status: "completed",
        });
      }),
    ),
  );

  it.effect("answers a completed response that reports no usage", () =>
    withVia(
      () =>
        reply.sse(
          sse([
            {
              type: "response.completed",
              response: { id: "resp_1", status: "completed", output: [] },
            },
          ]),
        ),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", request);
          expect(response.status).toBe(200);
          expect(yield* response.json).toEqual({ id: "resp_1", status: "completed", output: [] });
        }),
    ),
  );

  it.effect("uses the first account while it works", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/responses", request);
        expect(via.upstreamRequests[0]?.headers["chatgpt-account-id"]).toBe("acc-a");
      }),
    ),
  );

  it.effect(
    "moves on to the next account when one hits its usage limit, and lets it cool down",
    () =>
      withVia(
        (received) => (accountOf(received) === "acc-a" ? usageLimit(3600) : ok()),
        (via) =>
          Effect.gen(function* () {
            expect((yield* via.post("/v1/responses", request)).status).toBe(200);
            expect((yield* via.post("/v1/responses", request)).status).toBe(200);
            expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-b", "acc-b"]);
          }),
      ),
  );

  it.effect("judges an error by its status when its body breaks off, and moves on", () =>
    withVia(
      (received) => (accountOf(received) === "acc-a" ? reply.hangUp(usageLimit(3600), 1) : ok()),
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-b"]);
        }),
    ),
  );

  it.effect("moves on to the next account when one fails its response with a rate limit", () =>
    Effect.flatMap(codexFixture("response-failed-rate-limit.sse"), (rateLimited) =>
      withVia(
        (received) => (accountOf(received) === "acc-a" ? reply.sse(rateLimited) : ok()),
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.post("/v1/responses", request);
            expect(response.status).toBe(200);
            expect(yield* response.json).toMatchObject({ status: "completed" });

            expect((yield* via.post("/v1/responses", request)).status).toBe(200);
            expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-b", "acc-b"]);
          }),
      ),
    ),
  );

  it.effect("cools down an account whose stream fails with a rate limit", () =>
    withVia(
      (received) =>
        accountOf(received) === "acc-a"
          ? reply.failed("rate_limit_exceeded", "Please try again in 20s.")
          : ok(),
      (via) =>
        Effect.gen(function* () {
          const streamed = yield* via.post("/v1/responses", { ...request, stream: true });
          expect(yield* streamed.text).toContain("rate_limit_exceeded");

          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-b"]);
        }),
    ),
  );

  it.effect("answers 429 with Retry-After when every account is cooling down", () =>
    withVia(
      () => reply.error(429, "", { "retry-after": "120" }),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", request);
          expect(response.status).toBe(429);
          expect(response.headers["retry-after"]).toBe("120");
          expect(yield* response.json).toMatchObject({
            error: { code: "rate_limit_exceeded" },
          });
        }),
    ),
  );

  it.effect("answers a Codex outage with 503 and Retry-After, cooling no account down", () =>
    withVia(
      (received) =>
        received.body["input"] === "first"
          ? reply.error(503, { error: { code: "server_is_overloaded" } }, { "retry-after": "1" })
          : ok(),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", { ...request, input: "first" });
          expect(response.status).toBe(503);
          expect(response.headers["retry-after"]).toBe("1");
          expect(yield* response.json).toMatchObject({
            error: { type: "server_error", code: "server_is_overloaded" },
          });

          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-a"]);
        }),
    ),
  );

  it.effect("answers a Codex server error with 502, without trying another account", () =>
    withVia(
      () => reply.error(500, { error: { type: "server_error", message: "Internal server error" } }),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", request);
          expect(response.status).toBe(502);
          expect(response.headers["retry-after"]).toBeUndefined();
          expect(yield* response.json).toMatchObject({
            error: {
              type: "server_error",
              code: "server_error",
              message: "Internal server error",
            },
          });
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a"]);
        }),
    ),
  );

  it.effect("returns a client error as-is, since another account would fail the same way", () =>
    withVia(
      () => reply.error(400, { error: { message: "bad input" } }),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", request);
          expect(response.status).toBe(400);
          expect(yield* response.json).toEqual({
            error: { message: "bad input" },
          });
          expect(via.upstreamRequests).toHaveLength(1);
        }),
    ),
  );

  it.effect("refreshes a rejected access token and retries with the same account", () =>
    withVia(
      (received) =>
        received.headers.authorization === `Bearer ${refreshedTokens.access_token}`
          ? ok()
          : reply.error(401, { error: { code: "token_expired" } }),
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-a"]);
        }),
    ),
  );

  it.effect("locks out an account that is still refused after a refresh, and moves on", () =>
    withVia(
      (received) =>
        accountOf(received) === "acc-a"
          ? reply.error(401, { error: { code: "account_deactivated" } })
          : ok(),
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-a", "acc-b", "acc-b"]);
        }),
    ),
  );

  it.effect("answers 503 when Codex refuses every account even after a refresh", () =>
    withVia(
      () => reply.error(401, {}),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", request);
          expect(response.status).toBe(503);
          expect(yield* response.json).toMatchObject({
            error: { type: "server_error", code: "no_accounts" },
          });
          // "a" is refused again after its refresh; "b" shares its refresh token, which the
          // issuer then refuses as reused, so "b" is locked out without a second try.
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-a", "acc-b"]);
        }),
    ),
  );

  it.effect("locks out an account whose refresh token is rejected, and moves on", () =>
    withVia(
      (received) => (accountOf(received) === "acc-a" ? reply.error(401, {}) : ok()),
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-b", "acc-b"]);
        }),
      { refreshResponse: { status: 400, body: { error: "invalid_grant" } } },
    ),
  );

  it.effect("cools down an account whose refresh after a 401 hits an auth-server hiccup", () =>
    withVia(
      (received) => (accountOf(received) === "acc-a" ? reply.error(401, {}) : ok()),
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-b", "acc-b"]);
        }),
      { refreshResponse: { status: 500, body: {} } },
    ),
  );

  it.effect("skips an expired account whose refresh token is rejected", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-b"]);
        }),
      {
        refreshResponse: { status: 400, body: { error: "invalid_grant" } },
        aExpiresAt: 0,
      },
    ),
  );

  it.effect("skips an account whose refresh hits an auth-server hiccup, and moves on", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.post("/v1/responses", request)).status).toBe(200);
          expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-b"]);
        }),
      { refreshResponse: { status: 500, body: {} }, aExpiresAt: 0 },
    ),
  );

  it.effect("sends a request that names no model to Codex", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        expect((yield* via.post("/v1/responses", { input: "hi" })).status).toBe(200);
        expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a"]);
      }),
    ),
  );

  it.effect("tells Codex the session the client named", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" }, undefined, {
          "x-opencode-session": "ses_1",
        });
        expect(via.upstreamRequests[0]?.headers["session_id"]).toBe("ses_1");
      }),
    ),
  );
});
