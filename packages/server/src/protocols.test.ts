import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type ProviderReply, providerReply } from "@via/providers/testing";
import { Effect, Option } from "effect";
import { ok, type Via, withVia } from "./testing/harness.ts";

/** OpenCode Go's answer for a model asked for in a protocol it doesn't speak. */
const unsupported = providerReply.json(
  {
    type: "error",
    error: { type: "ModelProtocolUnsupported", message: "Model does not support this protocol." },
  },
  400,
);

const sse = (events: ReadonlyArray<object>) =>
  events
    .map(
      (event) =>
        `event: ${"type" in event ? String(event.type) : ""}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join("");

const response = {
  id: "resp_go",
  object: "response",
  created_at: 1_700_000_000,
  model: "grok-4.7",
};

/** A Responses stream answering "hi", with its usage. */
const responsesAnswer = providerReply.sse(
  sse([
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: "hi",
    },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hi", annotations: [] }],
          },
        ],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    },
  ]),
);

/** Answers in Responses only, as OpenCode Go does for Grok. */
const responsesOnly: ProviderReply = (request) =>
  (request.path === "/responses" ? responsesAnswer : unsupported)(request);

const messageEvents = [
  {
    type: "message_start",
    message: { id: "msg_1", model: "minimax-m2.7", usage: { input_tokens: 9, output_tokens: 1 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
];

/** Answers in Anthropic's Messages only, as OpenCode Go does for MiniMax M2.7. */
const messagesOnly: ProviderReply = (request) => {
  if (request.path !== "/messages") return unsupported(request);

  return request.body["stream"] === true
    ? providerReply.sse(sse(messageEvents))(request)
    : providerReply.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "minimax-m2.7",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 9, cache_read_input_tokens: 3, output_tokens: 4 },
      })(request);
};

const chat = (via: Via, stream: boolean) =>
  Effect.flatMap(
    via.post("/v1/chat/completions", {
      model: "opencode-go/grok-4.7",
      stream,
      messages: [{ role: "user", content: "hi" }],
    }),
    (answer) => Effect.map(answer.text, (text) => ({ status: answer.status, text })),
  );

const paths = (via: Via) => via.provider.requests.map((request) => request.path);

layer(BunFileSystem.layer)("OpenCode Go's protocols", (it) => {
  it.effect("answers a Chat client for a model OpenCode Go serves only in Responses", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(responsesOnly);
        const answer = yield* chat(via, false);

        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.text)).toMatchObject({
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        });
        expect(paths(via)).toEqual(["/chat/completions", "/responses"]);
      }),
    ),
  );

  it.effect("streams that answer as Chat chunks, and keeps its usage", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(responsesOnly);
        const answer = yield* chat(via, true);

        expect(answer.status).toBe(200);
        expect(answer.text).toContain('"content":"hi"');
        expect(answer.text).toContain("data: [DONE]");

        const page = yield* via.usage.requests({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 5 });
        expect(page.requests[0]).toMatchObject({
          status: 200,
          inputTokens: Option.some(12),
          outputTokens: Option.some(3),
          error: Option.none(),
        });
      }),
    ),
  );

  it.effect("remembers the protocol a model speaks, so the next request goes straight to it", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(responsesOnly);
        yield* chat(via, false);
        yield* chat(via, true);

        expect(paths(via)).toEqual(["/chat/completions", "/responses", "/responses"]);
      }),
    ),
  );

  it.effect("answers a Chat client for a model OpenCode Go serves only in Messages", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(messagesOnly);
        const answer = yield* chat(via, false);

        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.text)).toMatchObject({
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        });

        expect(paths(via)).toEqual(["/chat/completions", "/responses", "/messages"]);
        const sent = via.provider.requests.at(-1);
        expect(sent?.headers["anthropic-version"]).toBe("2023-06-01");
        expect(sent?.body).toMatchObject({ max_tokens: 32_000, messages: [{ role: "user" }] });

        const page = yield* via.usage.requests({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 5 });
        expect(page.requests[0]).toMatchObject({
          inputTokens: Option.some(12),
          cachedTokens: Option.some(3),
          outputTokens: Option.some(4),
        });
      }),
    ),
  );

  it.effect("streams a Messages answer as Chat chunks, with its usage kept", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(messagesOnly);
        const answer = yield* chat(via, true);

        expect(answer.status).toBe(200);
        expect(answer.text).toContain('"content":"hi"');
        expect(answer.text).toContain("data: [DONE]");

        const page = yield* via.usage.requests({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 5 });
        expect(page.requests[0]).toMatchObject({
          inputTokens: Option.some(9),
          outputTokens: Option.some(4),
          streamEnd: Option.some("completed"),
        });
      }),
    ),
  );

  it.effect("passes any other refusal back as it came, without trying another protocol", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json(
            { error: { message: "Bad input", type: "invalid_request_error" } },
            400,
          ),
        );

        const answer = yield* chat(via, false);

        expect(answer.status).toBe(400);
        expect(answer.text).toContain("Bad input");
        expect(paths(via)).toEqual(["/chat/completions"]);
      }),
    ),
  );
});
