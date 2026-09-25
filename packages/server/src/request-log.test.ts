import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream, reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { Effect } from "effect";
import { withVia } from "./harness.ts";

const ok = () => reply.sse(completedStream("hello"));

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
            "http.method": "POST",
            "http.url": "/v1/chat/completions",
            "http.status": 200,
            model: "opencode-go/kimi-k3",
            served_by: "opencode-go",
            headers_ms: expect.any(Number),
            first_chunk_ms: expect.any(Number),
          },
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
            "http.method": "POST",
            "http.url": "/v1/responses",
            "http.status": 200,
            model: "gpt-6-astra",
            served_by: "a@example.com",
          },
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
          expect(yield* via.logged("a@example.com")).toMatchObject({
            level: "Warn",
            message: expect.stringMatching(/^a@example\.com is cooling down until \S+ \(\w+\)$/),
          });
          expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
            served_by: "b@example.com",
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
            message: "a@example.com is out of use: Codex rejects its token even after a refresh",
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
          annotations: { "http.method": "GET", "http.url": "/v1/models", "http.status": 401 },
        });
      }),
    ),
  );
});
