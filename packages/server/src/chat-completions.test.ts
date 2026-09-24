import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { withVia } from "./harness.ts";

const ok = () => ({ status: 200, body: completedStream("hello") });
const request = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] };

layer(BunFileSystem.layer)("POST /v1/chat/completions", (it) => {
  it.effect("answers with a chat completion, asking Codex in Responses terms", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/chat/completions", request);
        expect(response.status).toBe(200);
        expect(yield* response.json).toMatchObject({
          object: "chat.completion",
          model: "gpt-5.5",
          choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
        expect(via.upstreamRequests[0]?.body).toMatchObject({
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        });
      }),
    ),
  );

  it.effect("streams chat completion chunks to a streaming client", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/chat/completions", {
          ...request,
          stream: true,
          stream_options: { include_usage: true },
        });
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        const text = yield* response.text;
        expect(text).toContain('"delta":{"content":"hello"}');
        expect(text).toContain('"usage":{"prompt_tokens":10');
        expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      }),
    ),
  );

  it.effect("rejects a request without an API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/chat/completions", request, null);
        expect(response.status).toBe(401);
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects a malformed chat request with 400", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/chat/completions", { model: "gpt-5.5" });
        expect(response.status).toBe(400);
        expect(yield* response.json).toMatchObject({ error: { type: "invalid_request_error" } });
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );
});
