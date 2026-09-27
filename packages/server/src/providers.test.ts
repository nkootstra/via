import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply } from "@via/providers/testing";
import { Effect } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const completion = { id: "chatcmpl-or", object: "chat.completion", choices: [] };

layer(BunFileSystem.layer)("OpenAI-compatible providers", (it) => {
  it.effect("forwards a chat completion for a provider's model untranslated", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json(completion));

        const response = yield* via.post("/v1/chat/completions", {
          model: "openrouter/qwen/qwen3",
          temperature: 0.3,
          messages: [{ role: "user", content: "hi" }],
        });

        expect(response.status).toBe(200);
        expect(yield* response.json).toEqual(completion);
        expect(via.provider.requests).toEqual([
          expect.objectContaining({
            path: "/chat/completions",
            headers: expect.objectContaining({ authorization: "Bearer sk-provider" }),
            body: expect.objectContaining({
              model: "qwen/qwen3",
              temperature: 0.3,
              messages: [{ role: "user", content: "hi" }],
              session_id: expect.any(String),
            }),
          }),
        ]);
        expect(via.upstreamRequests).toEqual([]);
      }),
    ),
  );

  it.effect("streams a provider's answer back as it comes", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
        via.provider.respond(providerReply.sse(sse));

        const response = yield* via.post("/v1/chat/completions", {
          model: "openrouter/qwen/qwen3",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        });

        expect(response.headers["content-type"]).toContain("text/event-stream");
        expect(yield* response.text).toBe(sse);
      }),
    ),
  );

  it.effect("forwards a Responses request with the client's session", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json({ id: "resp_go" }));

        const response = yield* via.post(
          "/v1/responses",
          { model: "opencode-go/kimi-k3", input: "hi" },
          undefined,
          { "x-opencode-session": "ses_1" },
        );

        expect(yield* response.json).toEqual({ id: "resp_go" });
        expect(via.provider.requests[0]).toMatchObject({
          path: "/responses",
          headers: { "x-opencode-session": "ses_1" },
          body: { model: "kimi-k3", input: "hi" },
        });
      }),
    ),
  );

  it.effect("passes a provider's error through as it is", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const error = { error: { message: "slow down", code: 429 } };
        via.provider.respond(providerReply.json(error, 429));

        const response = yield* via.post("/v1/chat/completions", {
          model: "openrouter/qwen/qwen3",
          messages: [],
        });

        expect(response.status).toBe(429);
        expect(yield* response.json).toEqual(error);
      }),
    ),
  );

  it.effect("answers 502 when the provider can't be reached", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", {
            model: "openrouter/qwen/qwen3",
            input: "hi",
          });

          expect(response.status).toBe(502);
          expect(yield* response.json).toMatchObject({ error: { code: "upstream_unavailable" } });
        }),
      { providerUrl: "http://127.0.0.1:1" },
    ),
  );

  it.effect("sends models without a configured prefix to Codex", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", {
          model: "unknown/qwen3",
          input: "hi",
        });

        expect(response.status).toBe(200);
        expect(via.provider.requests).toEqual([]);
        expect(via.upstreamRequests[0]?.body).toMatchObject({ model: "unknown/qwen3" });
      }),
    ),
  );

  it.effect("moves opencode's session line out of the system prompt a provider is sent", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json(completion));
        yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          messages: [
            { role: "system", content: "<env>\n  Current conversation session ID: ses_a\n</env>" },
            { role: "user", content: "hi" },
          ],
        });
        expect(via.provider.requests[0]?.body).toMatchObject({
          messages: [
            { role: "system", content: "<env>\n</env>" },
            { role: "user", content: "Current conversation session ID: ses_a\n\nhi" },
          ],
        });
      }),
    ),
  );
});
