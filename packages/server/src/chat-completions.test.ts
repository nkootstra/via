import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, reply } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { ok, withVia } from "./testing/harness.ts";

const request = {
  model: "gpt-6-astra",
  messages: [{ role: "user", content: "hi" }],
};

layer(BunFileSystem.layer)("POST /v1/chat/completions", (it) => {
  it.effect("answers with a chat completion, asking Codex in Responses terms", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/chat/completions", request);
        expect(response.status).toBe(200);
        expect(yield* response.json).toMatchObject({
          object: "chat.completion",
          model: "gpt-6-astra",
          choices: [
            {
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        });
        expect(via.upstreamRequests[0]?.body).toMatchObject({
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "hi" }],
            },
          ],
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

  it.effect("cools down an account whose stream fails with a usage limit, for either client", () =>
    withVia(
      (received: CodexRequest) =>
        received.headers["chatgpt-account-id"] === "acc-a"
          ? reply.failed("usage_limit_reached", "The usage limit has been reached")
          : ok(),
      (via) =>
        Effect.gen(function* () {
          const streamed = yield* via.post("/v1/chat/completions", { ...request, stream: true });
          expect(yield* streamed.text).toContain("usage_limit_reached");

          expect((yield* via.post("/v1/chat/completions", request)).status).toBe(200);
          expect((yield* via.post("/v1/chat/completions", request)).status).toBe(200);
          expect(via.upstreamRequests.map((sent) => sent.headers["chatgpt-account-id"])).toEqual([
            "acc-a",
            "acc-b",
            "acc-b",
          ]);
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
        const response = yield* via.post("/v1/chat/completions", {
          model: "gpt-6-astra",
        });

        expect(response.status).toBe(400);
        expect(yield* response.json).toMatchObject({
          error: { type: "invalid_request_error" },
        });
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects a body that is not an object with 400", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/chat/completions", [request]);
        expect(response.status).toBe(400);
        expect(yield* response.json).toMatchObject({
          error: { type: "invalid_request_error", code: "invalid_request" },
        });
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );

  it.effect("asks Codex for the base model and effort behind a suffix alias", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/chat/completions", {
          ...request,
          model: "gpt-6-astra-high",
        });
        expect(via.upstreamRequests[0]?.body).toMatchObject({
          model: "gpt-6-astra",
          reasoning: { effort: "high" },
        });
      }),
    ),
  );

  it.effect("keeps every turn of a conversation in one Codex session", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/chat/completions", request);
        yield* via.post("/v1/chat/completions", {
          ...request,
          messages: [
            ...request.messages,
            { role: "assistant", content: "hello" },
            { role: "user", content: "and?" },
          ],
        });
        yield* via.post("/v1/chat/completions", {
          ...request,
          messages: [{ role: "user", content: "another chat" }],
        });

        const [first, second, other] = via.upstreamRequests.map(
          (upstream) => upstream.headers["session_id"],
        );

        expect(second).toBe(first);
        expect(other).not.toBe(first);
      }),
    ),
  );

  it.effect("moves OpenCode's session line out of the instructions Codex is sent", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/chat/completions", {
          model: "gpt-6-astra",
          messages: [
            { role: "system", content: "<env>\n  Current conversation session ID: ses_a\n</env>" },
            { role: "user", content: "hi" },
          ],
        });
        expect(via.upstreamRequests[0]?.body).toMatchObject({
          instructions: "<env>\n</env>",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Current conversation session ID: ses_a\n\nhi" },
              ],
            },
          ],
        });
      }),
    ),
  );
});
