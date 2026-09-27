import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { Deferred, Effect, Stream } from "effect";
import { ok, withVia } from "./harness.ts";

const cachedTokens = () =>
  reply.sse(
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
  );

const aRequestId = expect.stringMatching(/^[0-9a-f-]{36}$/);

layer(BunFileSystem.layer)("request log", (it) => {
  it.effect("logs a provider's streamed answer once it has been sent, with its timings", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.sse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          stream: true,
          messages: [],
        });

        yield* response.text;
        expect(yield* via.logged("Sent HTTP response")).toEqual({
          level: "Info",
          message: "Sent HTTP response",
          spans: ["http.span"],
          annotations: {
            request_id: aRequestId,
            "http.method": "POST",
            "http.url": "/v1/chat/completions",
            "http.status": 200,
            model: "opencode-go/kimi-k3",
            served_by: "opencode-go",
            headers_ms: expect.any(Number),
            first_chunk_ms: expect.any(Number),
            stream_end: "completed",
          },
        });
      }),
    ),
  );

  it.effect("logs a streamed answer that sent nothing without a first-chunk time", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.sse(""));

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          stream: true,
          messages: [],
        });

        yield* response.text;
        const { annotations } = yield* via.logged("Sent HTTP response");
        expect(annotations).toMatchObject({
          headers_ms: expect.any(Number),
          stream_end: "completed",
        });
        expect(annotations).not.toHaveProperty("first_chunk_ms");
      }),
    ),
  );

  it.effect("logs a streamed answer the client stopped reading as client_aborted", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.sseThenHang('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          stream: true,
          messages: [],
        });

        yield* response.stream.pipe(Stream.take(1), Stream.runDrain);
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          stream_end: "client_aborted",
        });
      }),
    ),
  );

  it.effect("logs a streamed answer the upstream broke off as failed", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        // The upstream breaks off only once the client has the first chunk, so via has
        // already answered 200 and the failure can only reach the stream.
        const received = yield* Deferred.make<void>();
        via.provider.respond(
          providerReply.sseThenDrop(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
            Deferred.await(received),
          ),
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          stream: true,
          messages: [],
        });

        yield* response.stream.pipe(
          Stream.tap(() => Deferred.succeed(received, undefined)),
          Stream.runDrain,
          Effect.ignore,
        );
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          stream_end: "failed",
        });
      }),
    ),
  );

  it.effect("logs a Codex answer with the account that served it", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
        expect(yield* via.logged("Sent HTTP response")).toEqual({
          level: "Info",
          message: "Sent HTTP response",
          spans: ["http.span"],
          annotations: {
            request_id: aRequestId,
            "http.method": "POST",
            "http.url": "/v1/responses",
            "http.status": 200,
            model: "gpt-6-astra",
            served_by: "a@example.com",
            input_tokens: 10,
            output_tokens: 2,
          },
        });
      }),
    ),
  );

  it.effect("logs token usage for a non-streamed Codex answer to /v1/chat/completions", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/chat/completions", {
          model: "gpt-6-astra",
          messages: [{ role: "user", content: "hi" }],
        });
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 10,
          output_tokens: 2,
        });
      }),
    ),
  );

  it.effect("logs the cached tokens Codex reports, alongside input and output", () =>
    withVia(cachedTokens, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 10,
          output_tokens: 2,
          cached_tokens: 4,
        });
      }),
    ),
  );

  it.effect("logs token usage for a streamed Codex answer to /v1/responses", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", {
          model: "gpt-6-astra",
          input: "hi",
          stream: true,
        });

        yield* response.text;
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 10,
          output_tokens: 2,
        });
      }),
    ),
  );

  it.effect("logs token usage for a streamed Codex answer to /v1/chat/completions", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/chat/completions", {
          model: "gpt-6-astra",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        });

        yield* response.text;
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 10,
          output_tokens: 2,
        });
      }),
    ),
  );

  it.effect("logs the token usage a streamed provider answer reports", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.sse(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
          ),
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          stream: true,
          messages: [],
        });

        yield* response.text;
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 7,
          output_tokens: 3,
        });
      }),
    ),
  );

  it.effect("logs the token usage a non-streamed provider answer reports", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json({
            choices: [{ message: { role: "assistant", content: "hi" } }],
            usage: { prompt_tokens: 5, completion_tokens: 1 },
          }),
        );
        yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          messages: [],
        });
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 5,
          output_tokens: 1,
        });
      }),
    ),
  );

  it.effect("warns when an account cools down, and logs the account that took over", () =>
    withVia(
      (request) =>
        request.headers["chatgpt-account-id"] === "acc-a"
          ? reply.error(429, "", { "retry-after": "120" })
          : ok(),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          const warning = yield* via.logged("a@example.com");
          expect(warning).toMatchObject({
            level: "Warn",
            message: expect.stringMatching(/^a@example\.com is cooling down until \S+ \(\w+\)$/),
            annotations: { request_id: aRequestId },
          });
          const sent = yield* via.logged("Sent HTTP response");
          expect(sent.annotations).toMatchObject({
            served_by: "b@example.com",
            // Retrying on the second account keeps the same ID as the warning above.
            request_id: warning.annotations["request_id"],
          });
        }),
    ),
  );

  it.effect("warns when an account's refresh token is rejected, locking it out", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          expect(yield* via.logged("a@example.com")).toMatchObject({
            level: "Warn",
            message: "a@example.com is locked out until it logs in again (invalid_grant)",
          });
        }),
      { refreshResponse: { status: 400, body: { error: "invalid_grant" } }, aExpiresAt: 0 },
    ),
  );

  it.effect("warns when an account's refresh token is rejected after a 401, locking it out", () =>
    withVia(
      (request) =>
        request.headers["chatgpt-account-id"] === "acc-a" ? reply.error(401, "") : ok(),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          expect(yield* via.logged("a@example.com")).toMatchObject({
            level: "Warn",
            message: "a@example.com is locked out until it logs in again (invalid_grant)",
          });
        }),
      { refreshResponse: { status: 400, body: { error: "invalid_grant" } } },
    ),
  );

  it.effect("warns when the auth server cannot refresh an account's token", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          expect(yield* via.logged("a@example.com")).toMatchObject({
            level: "Warn",
            message: expect.stringMatching(
              /^a@example\.com is cooling down until \S+ \(auth_unavailable\)$/,
            ),
          });
        }),
      { refreshResponse: { status: 500, body: { error: "server_error" } }, aExpiresAt: 0 },
    ),
  );

  it.effect("warns when Codex rejects an account's token even after a refresh", () =>
    withVia(
      (request) =>
        request.headers["chatgpt-account-id"] === "acc-a" ? reply.error(401, "") : ok(),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          expect(yield* via.logged("a@example.com")).toMatchObject({
            level: "Warn",
            message: "a@example.com is locked out until it logs in again (unauthorized)",
          });
        }),
    ),
  );

  it.effect("logs a request via turns away itself with its model and why", () =>
    withVia(
      () => reply.error(429, "", { "retry-after": "120" }),
      (via) =>
        Effect.gen(function* () {
          // Cools both accounts down; the next request has no account to try.
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          // Both accounts were tried, but neither served it.
          expect((yield* via.logged("Sent HTTP response")).annotations).toEqual({
            request_id: aRequestId,
            "http.method": "POST",
            "http.url": "/v1/responses",
            "http.status": 429,
            model: "gpt-6-astra",
            error: "rate_limit_exceeded",
            retry_after: "120",
          });
          yield* via.post("/v1/chat/completions", { model: "gpt-6-sol", messages: [] });
          expect(yield* via.logged("gpt-6-sol")).toEqual({
            level: "Info",
            message: "Sent HTTP response",
            spans: ["http.span"],
            annotations: {
              request_id: aRequestId,
              "http.method": "POST",
              "http.url": "/v1/chat/completions",
              "http.status": 429,
              model: "gpt-6-sol",
              error: "rate_limit_exceeded",
              retry_after: "120",
            },
          });
        }),
    ),
  );

  it.effect("keeps a client-sent request ID, lower-cased, and echoes it on the response", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post(
          "/v1/responses",
          { model: "gpt-6-astra", input: "hi" },
          undefined,
          { "x-request-id": "550E8400-E29B-41D4-A716-446655440000" },
        );

        expect(response.headers["x-request-id"]).toBe("550e8400-e29b-41d4-a716-446655440000");
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          request_id: "550e8400-e29b-41d4-a716-446655440000",
        });
      }),
    ),
  );

  it.effect("generates a fresh UUID request ID when the client sends none", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
        expect(response.headers["x-request-id"]).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          request_id: response.headers["x-request-id"],
        });
      }),
    ),
  );

  it.effect("generates a fresh UUID request ID when the client sends the header twice", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const first = "550e8400-e29b-41d4-a716-446655440000";
        const second = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

        const response = yield* via.post(
          "/v1/responses",
          { model: "gpt-6-astra", input: "hi" },
          undefined,
          { "x-request-id": [first, second] },
        );

        expect(response.headers["x-request-id"]).not.toBe(first);
        expect(response.headers["x-request-id"]).not.toBe(second);
        expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      }),
    ),
  );

  it.effect("generates a fresh UUID request ID when the client's is not a valid UUID", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post(
          "/v1/responses",
          { model: "gpt-6-astra", input: "hi" },
          undefined,
          { "x-request-id": "not-a-uuid" },
        );

        expect(response.headers["x-request-id"]).not.toBe("not-a-uuid");
        expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      }),
    ),
  );

  it.effect("echoes a fresh request id even when no route matches", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/nope-not-a-route", null);
        expect(response.status).toBe(404);
        expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      }),
    ),
  );

  it.effect("logs a request no route matches with the id it answered with", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/nope-not-a-route", null);
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          request_id: response.headers["x-request-id"],
          "http.url": "/nope-not-a-route",
          "http.status": 404,
        });
      }),
    ),
  );

  it.effect("logs a request turned away without its model", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.get("/v1/models", null);
        expect(yield* via.logged("Sent HTTP response")).toEqual({
          level: "Info",
          message: "Sent HTTP response",
          spans: ["http.span"],
          annotations: {
            request_id: aRequestId,
            "http.method": "GET",
            "http.url": "/v1/models",
            "http.status": 401,
            error: "invalid_api_key",
          },
        });
      }),
    ),
  );
});
