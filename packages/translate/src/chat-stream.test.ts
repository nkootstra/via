import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { toChatStream } from "./chat-stream.ts";

const sse = (events: ReadonlyArray<object>) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const created = {
  type: "response.created",
  response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-6-astra" },
};
const completed = {
  type: "response.completed",
  response: { usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } },
};

const upstream = (events: ReadonlyArray<object>) =>
  Stream.make(new TextEncoder().encode(sse(events)));

/** The `data:` payloads a chat client receives for the given upstream events. */
const chatEvents = (events: ReadonlyArray<object>, options = { includeUsage: false }) =>
  chatEventsOf(upstream(events), options);

const chatEventsOf = <E>(body: Stream.Stream<Uint8Array, E>, options = { includeUsage: false }) =>
  toChatStream(body, options).pipe(
    Stream.decodeText,
    Stream.mkString,
    Effect.map((text) =>
      text
        .split("\n\n")
        .filter((block) => block !== "")
        .map((block) => block.replace(/^data: /, ""))
        .map((data) => (data === "[DONE]" ? data : JSON.parse(data))),
    ),
  );

const deltas = (events: ReadonlyArray<unknown>) =>
  events.flatMap((event) =>
    typeof event === "object" && event !== null && "choices" in event
      ? (event.choices as ReadonlyArray<{ delta: object; finish_reason: string | null }>)
      : [],
  );

describe("toChatStream", () => {
  it.effect("streams text deltas as chat chunks, then finishes and says [DONE]", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        { type: "response.output_text.delta", delta: "Hel" },
        { type: "response.output_text.delta", delta: "lo" },
        completed,
      ]);
      expect(events[0]).toEqual({
        id: "resp_1",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "gpt-6-astra",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      });
      expect(deltas(events)).toEqual([
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        { index: 0, delta: { content: "Hel" }, finish_reason: null },
        { index: 0, delta: { content: "lo" }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]);
      expect(events.at(-1)).toBe("[DONE]");
    }),
  );

  it.effect("streams function calls as tool call deltas and finishes for them", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "function_call", call_id: "call_1", name: "weather", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"city":' },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: '"Paris"}' },
        completed,
      ]);
      expect(deltas(events).slice(1)).toEqual([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "weather", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
          finish_reason: null,
        },
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
          finish_reason: null,
        },
        { index: 0, delta: {}, finish_reason: "tool_calls" },
      ]);
    }),
  );

  it.effect("sends a usage chunk before [DONE] when the client asked for usage", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([created, completed], { includeUsage: true });
      expect(events.at(-2)).toMatchObject({
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      });
    }),
  );

  it.effect("ends a failed response with an error chunk instead of [DONE]", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        {
          type: "response.failed",
          response: { error: { code: "server_is_overloaded", message: "Codex is busy" } },
        },
      ]);
      expect(events).not.toContain("[DONE]");
      expect(events.at(-1)).toEqual({
        error: { message: "Codex is busy", type: "server_error", code: "server_is_overloaded" },
      });
    }),
  );

  it.effect("ends a stream cut off before completing with an upstream_incomplete error", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        { type: "response.output_text.delta", delta: "Hel" },
      ]);
      expect(events).not.toContain("[DONE]");
      expect(events.at(-1)).toMatchObject({
        error: { type: "server_error", code: "upstream_incomplete" },
      });
    }),
  );

  it.effect("ends a stream that broke while reading with an upstream_incomplete error", () =>
    Effect.gen(function* () {
      const events = yield* chatEventsOf(
        upstream([created]).pipe(Stream.concat(Stream.fail("connection reset"))),
      );
      expect(events).not.toContain("[DONE]");
      expect(events.at(-1)).toMatchObject({
        error: { type: "server_error", code: "upstream_incomplete" },
      });
    }),
  );

  it.effect.each([
    { reason: "max_output_tokens", finish: "length" },
    { reason: "content_filter", finish: "content_filter" },
  ])("finishes an incomplete response ($reason) with $finish and [DONE]", ({ reason, finish }) =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        { type: "response.output_text.delta", delta: "Hel" },
        {
          type: "response.incomplete",
          response: { incomplete_details: { reason }, usage: completed.response.usage },
        },
      ]);
      expect(deltas(events).at(-1)).toEqual({ index: 0, delta: {}, finish_reason: finish });
      expect(events.at(-1)).toBe("[DONE]");
    }),
  );
});
