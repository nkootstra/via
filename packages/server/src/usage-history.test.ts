import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { UsageHistory } from "@via/usage";
import { Effect, Layer, Option } from "effect";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { ok, type Via, withVia } from "./testing/harness.ts";

/** A prompt an upstream's error quotes back, which the usage history must never keep. */
const PROMPT = "REVIEW_PRIVATE_PROMPT_7a19";

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

  it.effect("keeps a provider's error code, but not its message", () =>
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
          errorMessage: Option.none(),
        });

        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          upstream_error: "ModelProtocolUnsupported",
        });
      }),
    ),
  );

  it.effect("keeps no error message for a Codex refusal, which says why only in a detail", () =>
    withVia(
      () => reply.error(400, { detail: "Input must be a list" }),
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          const [request] = yield* recorded(via);

          expect(request).toMatchObject({
            status: 400,
            error: Option.none(),
            errorMessage: Option.none(),
          });
        }),
    ),
  );

  it.effect("keeps via's words, not Codex's, for a response Codex failed", () =>
    withVia(
      () =>
        reply.sse(
          `event: response.failed\ndata: ${JSON.stringify({
            type: "response.failed",
            response: { error: { code: "server_is_overloaded", message: PROMPT } },
          })}\n\n`,
        ),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", {
            model: "gpt-6-astra",
            input: PROMPT,
          });

          // The client still hears why.
          expect(yield* response.text).toContain(PROMPT);
          const [request] = yield* recorded(via);

          expect(request).toMatchObject({
            error: Option.some("server_is_overloaded"),
            errorMessage: Option.some("Codex failed the response"),
          });
        }),
    ),
  );

  it.effect("names the provider, not Codex, for a response OpenCode Go failed", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond((request) =>
          request.path === "/responses"
            ? {
                status: 200,
                contentType: "text/event-stream",
                body: `event: response.failed\ndata: ${JSON.stringify({
                  type: "response.failed",
                  response: { error: { code: "invalid_prompt", message: PROMPT } },
                })}\n\n`,
              }
            : {
                status: 400,
                contentType: "application/json",
                body: JSON.stringify({ error: { code: "ModelProtocolUnsupported" } }),
              },
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/test",
          messages: [{ role: "user", content: PROMPT }],
        });

        expect(yield* response.text).toContain(PROMPT);
        const [request] = yield* recorded(via);

        expect(request).toMatchObject({
          error: Option.some("invalid_prompt"),
          errorMessage: Option.some("OpenCode Go failed the response"),
        });
      }),
    ),
  );

  it.effect("keeps via's words, not Codex's, for a Codex outage", () =>
    withVia(
      () => reply.error(500, { error: { code: "server_error", message: PROMPT } }),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/chat/completions", {
            model: "gpt-6-astra",
            messages: [{ role: "user", content: PROMPT }],
          });

          expect(yield* response.text).toContain(PROMPT);
          const [request] = yield* recorded(via);

          expect(request).toMatchObject({
            status: 502,
            error: Option.some("server_error"),
            errorMessage: Option.some("Codex failed the request (HTTP 500)"),
          });
        }),
    ),
  );

  it.effect(
    "keeps an upstream's status and code, never its message, which can quote the prompt",
    () =>
      withVia(ok, (via) =>
        Effect.gen(function* () {
          via.provider.respond((request) => ({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "invalid_input", message: request.body.input } }),
          }));

          const response = yield* via.post("/v1/responses", {
            model: "openrouter/test",
            input: PROMPT,
          });

          // What the client gets is unchanged: the upstream's answer, as it sent it.
          expect(yield* response.text).toContain(PROMPT);
          const [request] = yield* recorded(via);

          expect(request).toMatchObject({
            status: 400,
            error: Option.some("invalid_input"),
            errorMessage: Option.none(),
          });
        }),
      ),
  );

  it.effect("keeps no error code that isn't an identifier, as one quoting the prompt", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond((request) => ({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: `bad input: ${request.body.input}` } }),
        }));

        yield* (yield* via.post("/v1/responses", { model: "openrouter/test", input: PROMPT })).text;
        const [request] = yield* recorded(via);

        expect(request).toMatchObject({ status: 400, error: Option.none() });
        expect(JSON.stringify(request)).not.toContain(PROMPT);
        expect(JSON.stringify((yield* via.logged("Sent HTTP response")).annotations)).not.toContain(
          PROMPT,
        );
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
  it.effect("records a cut-off Responses stream as failed", () =>
    withVia(
      () =>
        reply.sse('event: response.created\ndata: {"type":"response.created","response":{}}\n\n'),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", {
            model: "gpt-6-astra",
            input: "hi",
            stream: true,
          });

          expect(response.status).toBe(200);
          expect(yield* response.text).toContain("upstream_incomplete");
          const [request] = yield* recorded(via);
          expect(request?.streamEnd).toEqual(Option.some("failed"));
        }),
    ),
  );
  it.effect("records a cut-off Messages stream as failed", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond((request) =>
          request.path === "/messages"
            ? {
                status: 200,
                contentType: "text/event-stream",
                body: `event: message_start\ndata: ${JSON.stringify({
                  type: "message_start",
                  message: { id: "msg_1", model: "test", usage: { input_tokens: 1 } },
                })}\n\n`,
              }
            : {
                status: 400,
                contentType: "application/json",
                body: JSON.stringify({ error: { code: "ModelProtocolUnsupported" } }),
              },
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/test",
          messages: [],
          stream: true,
        });

        expect(yield* response.text).toContain("upstream_incomplete");
        expect(via.provider.requests.map(({ path }) => path)).toEqual([
          "/chat/completions",
          "/responses",
          "/messages",
        ]);
        const [request] = yield* recorded(via);
        expect(request?.streamEnd).toEqual(Option.some("failed"));
      }),
    ),
  );
});
