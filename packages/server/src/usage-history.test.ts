import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { UsageHistory } from "@via/usage";
import { Effect, Layer, Option } from "effect";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import { ok, type Via, withVia } from "./testing/harness.ts";

/** Every request the history has, newest first, once via has logged the last one. */
const recorded = (via: Via) =>
  Effect.gen(function* () {
    yield* via.logged("Sent HTTP response");
    const page = yield* via.usage.requests({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 100 });

    return page.requests;
  });

layer(BunFileSystem.layer)("usage history", (it) => {
  it.effect("keeps a Codex request with its key, account and tokens", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
        const [request] = yield* recorded(via);

        expect(request).toMatchObject({
          status: 200,
          keyName: Option.some("test"),
          model: "gpt-6-astra",
          provider: "codex",
          accountLabel: Option.some("a@example.com"),
          inputTokens: Option.some(10),
          outputTokens: Option.some(2),
          error: Option.none(),
          streamEnd: Option.none(),
        });

        expect(Option.isSome(request?.keyId ?? Option.none())).toBe(true);
        expect(Option.isSome(request?.accountId ?? Option.none())).toBe(true);
      }),
    ),
  );

  it.effect("keeps a streamed OpenCode Go request once its stream has ended", () =>
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
        const [request] = yield* recorded(via);

        expect(request).toMatchObject({
          model: "opencode-go/kimi-k3",
          provider: "opencode-go",
          accountLabel: Option.some("go-1"),
          inputTokens: Option.some(7),
          outputTokens: Option.some(3),
          streamEnd: Option.some("completed"),
          firstChunkMs: Option.some(expect.any(Number)),
        });
      }),
    ),
  );

  it.effect("keeps a plain provider's request, with the cost it reports and no account", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json({
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.001 },
          }),
        );

        yield* (yield* via.post("/v1/chat/completions", {
          model: "openrouter/minimax-m3",
          messages: [],
        })).text;

        const [request] = yield* recorded(via);

        expect(request).toMatchObject({
          provider: "openrouter",
          accountId: Option.none(),
          accountLabel: Option.none(),
          costUsd: Option.some(0.001),
        });
      }),
    ),
  );

  it.effect("gives a non-streamed answer no stream timings, though via relays it as a stream", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
        );

        yield* (yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          messages: [],
        })).text;

        const [request] = yield* recorded(via);

        expect(request).toMatchObject({
          inputTokens: Option.some(7),
          streamEnd: Option.none(),
          firstChunkMs: Option.none(),
        });
      }),
    ),
  );

  it.effect("keeps a request via turned away, with why", () =>
    withVia(
      () => reply.error(429, "", { "retry-after": "120" }),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          const [request] = yield* recorded(via);

          expect(request).toMatchObject({
            status: 429,
            error: Option.some("rate_limit_exceeded"),
            errorMessage: Option.some("Every account is cooling down"),
            provider: "codex",
            accountId: Option.none(),
            inputTokens: Option.none(),
          });
        }),
    ),
  );

  it.effect("keeps why a provider refused a request, in its words", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json(
            {
              type: "error",
              error: {
                type: "ModelProtocolUnsupported",
                message: "Model does not support this protocol.",
              },
            },
            400,
          ),
        );

        yield* (yield* via.post("/v1/responses", { model: "opencode-go/kimi-k3", input: [] })).text;
        const [request] = yield* recorded(via);

        expect(request).toMatchObject({
          status: 400,
          error: Option.some("ModelProtocolUnsupported"),
          errorMessage: Option.some("Model does not support this protocol."),
        });

        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          upstream_error: "ModelProtocolUnsupported",
        });
      }),
    ),
  );

  it.effect("keeps why Codex refused a request, which it says only in a detail", () =>
    withVia(
      () => reply.error(400, { detail: "Input must be a list" }),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          const [request] = yield* recorded(via);

          expect(request).toMatchObject({
            status: 400,
            error: Option.none(),
            errorMessage: Option.some("Input must be a list"),
          });
        }),
    ),
  );

  it.effect("cuts the message Codex failed a response with to 500 characters", () =>
    withVia(
      () =>
        reply.sse(
          `event: response.failed\ndata: ${JSON.stringify({
            type: "response.failed",
            response: { error: { code: "server_is_overloaded", message: "x".repeat(2_000) } },
          })}\n\n`,
        ),
      (via) =>
        Effect.gen(function* () {
          yield* (yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" })).text;
          const [request] = yield* recorded(via);

          expect(request?.status).toBe(502);
          expect(request?.errorMessage).toEqual(Option.some("x".repeat(500)));
        }),
    ),
  );

  it.effect("keeps no request that asked for no model, such as a model list or a bad key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.get("/v1/models");
        yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" }, "sk-wrong");
        yield* via.post("/v1/responses", { model: "gpt-6-sol", input: "hi" });
        yield* via.logged("gpt-6-sol");
        const requests = yield* recorded(via);

        expect(requests.map((r) => r.model)).toEqual(["gpt-6-sol"]);
      }),
    ),
  );

  it.effect("still answers when the history can't keep a request", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          expect(response.status).toBe(200);
          expect((yield* via.logged("Could not keep")).level).toBe("Warn");
        }),
      {
        history: Layer.effect(
          UsageHistory,
          Effect.map(UsageHistory, (history) => ({
            ...history,
            record: () =>
              Effect.fail(
                new SqlError({ reason: new UnknownError({ cause: new Error("disk full") }) }),
              ),
          })),
        ).pipe(Layer.provide(UsageHistory.layerMemory)),
      },
    ),
  );
});
