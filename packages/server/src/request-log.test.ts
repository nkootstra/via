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
        const line = yield* via.logged("POST /v1/chat/completions");
        expect(line).toMatch(
          /^Info POST \/v1\/chat\/completions 200 · opencode-go\/kimi-k3 via opencode-go · headers \d+ms · first chunk \d+ms · done \d+ms$/,
        );
      }),
    ),
  );

  it.effect("logs a Codex answer with the account that served it", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
        expect(yield* via.logged("POST /v1/responses")).toMatch(
          /^Info POST \/v1\/responses 200 · gpt-6-astra via a@example\.com · \d+ms$/,
        );
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
          expect(yield* via.logged("a@example.com")).toMatch(
            /^Warn a@example\.com is cooling down until \S+ \(\w+\)$/,
          );
          expect(yield* via.logged("POST /v1/responses")).toContain("via b@example.com");
        }),
    ),
  );

  it.effect("warns when an account's refresh token is rejected, locking it out", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          expect(yield* via.logged("a@example.com")).toBe(
            "Warn a@example.com is locked out until it logs in again (invalid_grant)",
          );
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
          expect(yield* via.logged("a@example.com")).toMatch(
            /^Warn a@example\.com is cooling down until \S+ \(auth_unavailable\)$/,
          );
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
          expect(yield* via.logged("a@example.com")).toBe(
            "Warn a@example.com is out of use: Codex rejects its token even after a refresh",
          );
        }),
    ),
  );

  it.effect("logs a request turned away without its model", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.get("/v1/models", null);
        expect(yield* via.logged("GET /v1/models")).toMatch(/^Info GET \/v1\/models 401 · \d+ms$/);
      }),
    ),
  );
});
