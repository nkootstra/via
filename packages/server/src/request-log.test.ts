import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { Deferred, Effect, Exit, FileSystem, Option, Stream } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const cachedTokens = () =>
  reply.sse(
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
  );

const aRequestId = expect.stringMatching(/^[0-9a-f-]{36}$/);

layer(BunFileSystem.layer)("request log", (it) => {
  it.effect("logs why a request failed with a defect, not just its 500", () =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(`${via.dir}/keys.json`, "not json");

            const response = yield* via.get("/admin/keys", "admin-key-that-is-long-enough-000");
            expect(response.status).toBe(500);

            const line = yield* via.logged("failed unexpectedly");
            expect(line.level).toBe("Error");
            expect(line.message).toContain("keys.json");
          }),
        { adminKey: "admin-key-that-is-long-enough-000" },
      ),
    ),
  );

  it.effect("logs a request for no route as its 404, not as an error", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/nowhere");
        expect(response.status).toBe(404);

        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          "http.status": 404,
        });
        expect(via.logs.filter((line) => line.level === "Error")).toEqual([]);
      }),
    ),
  );

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
            key: "test",
            model: "opencode-go/kimi-k3",
            served_by: "go-1",
            headers_ms: expect.any(Number),
            first_chunk_ms: expect.any(Number),
            stream_end: "completed",
          },
        });
      }),
    ),
  );

  it.effect("logs a provider's answer the client didn't ask to stream without stream timings", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json({ choices: [] }));

        yield* (yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          messages: [],
        })).text;

        const { annotations } = yield* via.logged("Sent HTTP response");
        expect(annotations).not.toHaveProperty("headers_ms");
        expect(annotations).not.toHaveProperty("first_chunk_ms");
        expect(annotations).not.toHaveProperty("stream_end");
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

  it.effect("logs a streamed answer the client abandoned before reading any of it", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.sseThenHang('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
        );

        // Aborted as soon as the headers arrive, so the body is never read.
        const abort = new AbortController();
        yield* Effect.promise(() =>
          fetch(`${via.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${via.key}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "opencode-go/kimi-k3", stream: true, messages: [] }),
            signal: abort.signal,
          }),
        );
        abort.abort();
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          "http.status": 200,
          stream_end: "client_aborted",
        });
      }),
    ),
  );

  it.effect(
    "logs a request the client gave up on before via answered as 499, not as an error",
    () => {
      const asked = Deferred.makeUnsafe<void>();
      // Never opened: Codex takes longer than the client is willing to wait.
      const gate = Deferred.makeUnsafe<void>();

      return withVia(
        () => (request) => {
          Deferred.doneUnsafe(asked, Exit.void);

          return reply.held(gate, ok())(request);
        },
        (via) =>
          Effect.gen(function* () {
            const abort = new AbortController();

            const sent = fetch(`${via.baseUrl}/v1/responses`, {
              method: "POST",
              headers: { authorization: `Bearer ${via.key}`, "content-type": "application/json" },
              body: JSON.stringify({ model: "gpt-6-astra", input: "hi" }),
              signal: abort.signal,
            }).catch(() => undefined);

            yield* Deferred.await(asked);
            abort.abort();
            yield* Effect.promise(() => sent);
            expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
              "http.status": 499,
            });
            expect(via.logs.filter((line) => line.level === "Error")).toEqual([]);
          }),
      );
    },
  );

  it.effect("logs a provider's answer whose body is never sent, such as a 204", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        // A 204 has no body, so the server never runs the relayed stream.
        via.provider.respond(providerReply.json({}, 204));

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          stream: true,
          messages: [],
        });

        expect(response.status).toBe(204);
        const { annotations } = yield* via.logged("Sent HTTP response");
        expect(annotations).toMatchObject({ "http.status": 204, served_by: "go-1" });
        expect(annotations).not.toHaveProperty("stream_end");
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
            key: "test",
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

  it.effect("logs the reasoning tokens and cost a provider reports", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json({
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 8,
              total_tokens: 18,
              completion_tokens_details: { reasoning_tokens: 6 },
              cost: 0.00042,
            },
          }),
        );

        yield* (yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          messages: [],
        })).text;
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 10,
          output_tokens: 8,
          reasoning_tokens: 6,
          cost_usd: 0.00042,
        });
      }),
    ),
  );

  it.effect("logs and keeps the input a provider says it wrote to the cache", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json({
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12,
              prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 7 },
            },
          }),
        );

        yield* (yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          messages: [],
        })).text;
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          input_tokens: 10,
          cache_write_tokens: 7,
        });

        const page = yield* via.usage.requests({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 1 });
        expect(page.requests[0]?.cacheWriteTokens).toEqual(Option.some(7));
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
            key: "test",
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
              key: "test",
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
