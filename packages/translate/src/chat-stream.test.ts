import { describe, expect, it } from "@effect/vitest";
import { sseFrames } from "@via/codex-upstream/testing";
import { Effect, Predicate, Schema, Stream } from "effect";
import { CompletedResponse, toChatCompletion } from "./chat-response.ts";
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

const functionCall = (output_index: number, call_id: string) => ({
  type: "response.output_item.added",
  output_index,
  item: { type: "function_call", call_id, name: "weather", arguments: "" },
});

const argumentsDelta = (output_index: number, delta: string) => ({
  type: "response.function_call_arguments.delta",
  output_index,
  delta,
});

const upstream = (events: ReadonlyArray<object>) =>
  Stream.make(new TextEncoder().encode(sse(events)));

/** The `data:` payloads a chat client receives for the given upstream events. */
const chatEvents = (events: ReadonlyArray<object>, options = { includeUsage: false }) =>
  chatEventsOf(upstream(events), options);

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const chatEventsOf = <E>(body: Stream.Stream<Uint8Array, E>, options = { includeUsage: false }) =>
  toChatStream(body, options).pipe(
    Stream.decodeText,
    Stream.mkString,
    Effect.map((text) =>
      sseFrames(text).map(({ data }) => (data === "[DONE]" ? data : decodeEvent(data))),
    ),
  );

const isChunk = Schema.is(Schema.Struct({ choices: Schema.Array(Schema.Unknown) }));

/** The choices of every chat chunk among `events`. */
const deltas = (events: ReadonlyArray<unknown>) =>
  events.flatMap((event) => (isChunk(event) ? event.choices : []));

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

  it.effect("streams a refusal as refusal deltas", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        { type: "response.refusal.delta", delta: "I can't " },
        { type: "response.refusal.delta", delta: "help with that." },
        completed,
      ]);

      expect(deltas(events)).toEqual([
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        { index: 0, delta: { refusal: "I can't " }, finish_reason: null },
        { index: 0, delta: { refusal: "help with that." }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]);
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

  it.effect("reports cached and reasoning tokens in the usage chunk", () =>
    Effect.gen(function* () {
      const usage = {
        ...completed.response.usage,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 2 },
      };

      const events = yield* chatEvents(
        [created, { type: "response.completed", response: { usage } }],
        { includeUsage: true },
      );

      expect(events.at(-2)).toMatchObject({
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          total_tokens: 17,
          prompt_tokens_details: { cached_tokens: 8 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      });
    }),
  );

  it.effect("finishes a response whose usage details are null, as Codex sends them", () =>
    Effect.gen(function* () {
      const usage = {
        input_tokens: 12,
        input_tokens_details: null,
        output_tokens: 5,
        output_tokens_details: null,
        total_tokens: 17,
      };

      const events = yield* chatEvents(
        [created, { type: "response.completed", response: { usage } }],
        { includeUsage: true },
      );

      expect(events.slice(-2)).toEqual([
        expect.objectContaining({
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
        }),
        "[DONE]",
      ]);
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
      expect(events.filter((event) => Predicate.hasProperty(event, "error"))).toHaveLength(1);
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

  it.effect("skips events that have no chat counterpart", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        { type: "response.in_progress", response: {} },
        { type: "response.output_item.added", output_index: 1, item: { type: "message" } },
        { type: "response.output_text.delta", delta: "Hi" },
        completed,
      ]);

      expect(deltas(events)).toEqual([
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        { index: 0, delta: { content: "Hi" }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]);
    }),
  );

  it.effect("streams reasoning summaries as reasoning content, a blank line between parts", () =>
    Effect.gen(function* () {
      const summary = (output_index: number, summary_index: number, delta: string) => ({
        type: "response.reasoning_summary_text.delta",
        item_id: `rs_${output_index}`,
        output_index,
        summary_index,
        delta,
      });

      const events = yield* chatEvents([
        created,
        summary(0, 0, "Weighing "),
        summary(0, 0, "it"),
        summary(0, 1, "Decided"),
        summary(2, 0, "Again"),
        { type: "response.output_text.delta", delta: "Hi" },
        completed,
      ]);

      expect(deltas(events).slice(1, -1)).toEqual([
        { index: 0, delta: { reasoning_content: "Weighing " }, finish_reason: null },
        { index: 0, delta: { reasoning_content: "it" }, finish_reason: null },
        { index: 0, delta: { reasoning_content: "\n\nDecided" }, finish_reason: null },
        { index: 0, delta: { reasoning_content: "\n\nAgain" }, finish_reason: null },
        { index: 0, delta: { content: "Hi" }, finish_reason: null },
      ]);
    }),
  );

  it.effect("routes interleaved argument deltas to the tool call they belong to", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        functionCall(3, "call_a"),
        functionCall(5, "call_b"),
        argumentsDelta(5, "b"),
        argumentsDelta(3, "a"),
        completed,
      ]);

      expect(deltas(events).slice(3, 5)).toEqual([
        {
          index: 0,
          delta: { tool_calls: [{ index: 1, function: { arguments: "b" } }] },
          finish_reason: null,
        },
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "a" } }] },
          finish_reason: null,
        },
      ]);
    }),
  );

  it.effect("drops argument deltas for a function call that was never announced", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        argumentsDelta(2, "{}"),
        { type: "response.output_text.delta", delta: "Hi" },
        completed,
      ]);

      expect(deltas(events)).toEqual([
        { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        { index: 0, delta: { content: "Hi" }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: "stop" },
      ]);
    }),
  );

  it.effect("does not take a malformed completion for the end of the response", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents([
        created,
        { type: "response.completed", response: { usage: "lots" } },
      ]);

      expect(events).not.toContain("[DONE]");
      expect(events.at(-1)).toMatchObject({ error: { code: "upstream_incomplete" } });
    }),
  );

  it.effect.each([
    { case: "leaves it out", response: { status: "completed" } },
    { case: "sends null", response: { status: "completed", usage: null } },
  ])("finishes a completed response whose usage Codex $case, with no usage chunk", ({ response }) =>
    Effect.gen(function* () {
      const events = yield* chatEvents(
        [
          created,
          { type: "response.output_text.delta", delta: "Hello" },
          { type: "response.completed", response },
        ],
        { includeUsage: true },
      );

      expect(deltas(events).at(-1)).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
      expect(events.filter((event) => Predicate.hasProperty(event, "usage"))).toEqual([]);
      expect(events.at(-1)).toBe("[DONE]");
    }),
  );

  it.effect("finishes an incomplete response that reports no usage", () =>
    Effect.gen(function* () {
      const events = yield* chatEvents(
        [
          created,
          {
            type: "response.incomplete",
            response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
          },
        ],
        { includeUsage: true },
      );

      expect(deltas(events).at(-1)).toMatchObject({ finish_reason: "content_filter" });
      expect(events.at(-1)).toBe("[DONE]");
    }),
  );
});

describe("toChatStream and toChatCompletion", () => {
  /** One output item of a response, with the pieces its text streams in. */
  const Item = Schema.Union([
    Schema.Struct({ type: Schema.Literal("message"), deltas: Schema.Array(Schema.String) }),
    Schema.Struct({
      type: Schema.Literal("function_call"),
      name: Schema.String,
      deltas: Schema.Array(Schema.String),
    }),
    Schema.Struct({ type: Schema.Literal("refusal"), deltas: Schema.Array(Schema.String) }),
    Schema.Struct({
      type: Schema.Literal("reasoning"),
      summary: Schema.Array(Schema.Array(Schema.String)),
    }),
  ]);

  const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }));

  const Scenario = Schema.Struct({
    items: Schema.Array(Item),
    incomplete: Schema.NullOr(Schema.Literals(["max_output_tokens", "content_filter"])),
    usage: Schema.Struct({ input_tokens: Count, output_tokens: Count, total_tokens: Count }),
  });

  type Scenario = typeof Scenario.Type;

  const isMessage = Schema.is(Item.members[0]);

  const isFunctionCall = Schema.is(Item.members[1]);

  const isRefusal = Schema.is(Item.members[2]);

  const isReasoning = Schema.is(Item.members[3]);

  const envelope = { id: "resp_1", created_at: 1_700_000_000, model: "gpt-6-astra" };

  /** The scenario's response as the Responses API sends it without streaming. */
  const whole = ({ items, incomplete, usage }: Scenario) => ({
    ...envelope,
    output: items.map((item, index) => {
      if (isMessage(item)) {
        return { type: "message", content: [{ type: "output_text", text: item.deltas.join("") }] };
      }

      if (isFunctionCall(item)) {
        const call = { call_id: `call_${index}`, name: item.name };

        return { type: "function_call", ...call, arguments: item.deltas.join("") };
      }

      if (isRefusal(item)) {
        return { type: "message", content: [{ type: "refusal", refusal: item.deltas.join("") }] };
      }

      const summary = isReasoning(item) ? item.summary : [];

      return {
        type: "reasoning",
        summary: summary.map((part) => ({ type: "summary_text", text: part.join("") })),
      };
    }),
    usage,
    incomplete_details: incomplete === null ? null : { reason: incomplete },
  });

  /** The scenario's response as the Responses API streams it. */
  const streamed = ({ items, incomplete, usage }: Scenario) => [
    { type: "response.created", response: envelope },
    ...items.flatMap((item, output_index) => {
      if (isMessage(item)) {
        return [
          { type: "response.output_item.added", output_index, item: { type: "message" } },
          ...item.deltas.map((delta) => ({ type: "response.output_text.delta", delta })),
        ];
      }

      if (isFunctionCall(item)) {
        const call = { type: "function_call", call_id: `call_${output_index}`, name: item.name };

        return [
          { type: "response.output_item.added", output_index, item: call },
          ...item.deltas.map((delta) => ({
            type: "response.function_call_arguments.delta",
            output_index,
            delta,
          })),
        ];
      }

      if (isRefusal(item)) {
        return [
          { type: "response.output_item.added", output_index, item: { type: "message" } },
          ...item.deltas.map((delta) => ({ type: "response.refusal.delta", delta })),
        ];
      }

      const summary = isReasoning(item) ? item.summary : [];

      return [
        { type: "response.output_item.added", output_index, item: { type: "reasoning" } },
        ...summary.flatMap((part, summary_index) =>
          part.map((delta) => ({
            type: "response.reasoning_summary_text.delta",
            output_index,
            summary_index,
            delta,
          })),
        ),
      ];
    }),
    incomplete === null
      ? { type: "response.completed", response: { usage } }
      : {
          type: "response.incomplete",
          response: { incomplete_details: { reason: incomplete }, usage },
        },
  ];

  const ToolCallDelta = Schema.Struct({
    index: Schema.Int,
    id: Schema.optionalKey(Schema.String),
    function: Schema.Struct({ name: Schema.optionalKey(Schema.String), arguments: Schema.String }),
  });

  const Chunk = Schema.Struct({
    id: Schema.String,
    created: Schema.Finite,
    model: Schema.String,
    choices: Schema.Array(
      Schema.Struct({
        delta: Schema.Struct({
          content: Schema.optionalKey(Schema.String),
          reasoning_content: Schema.optionalKey(Schema.String),
          refusal: Schema.optionalKey(Schema.String),
          tool_calls: Schema.optionalKey(Schema.Array(ToolCallDelta)),
        }),
        finish_reason: Schema.NullOr(Schema.String),
      }),
    ),
    usage: Schema.optionalKey(Schema.Json),
  });

  const decodeChunk = Schema.decodeUnknownSync(Chunk);

  /** Assembles streamed chat chunks into one answer, as a chat client does. */
  const assemble = (events: ReadonlyArray<Schema.Json>) => {
    const chunks = events.flatMap((event) => (event === "[DONE]" ? [] : [decodeChunk(event)]));
    const choices = chunks.flatMap((chunk) => chunk.choices);
    const toolDeltas = choices.flatMap((choice) => choice.delta.tool_calls ?? []);

    const calls = [...new Set(toolDeltas.map((delta) => delta.index))].map((index) => {
      const parts = toolDeltas.filter((delta) => delta.index === index);

      return {
        id: parts[0]?.id,
        type: "function",
        function: {
          name: parts.map((part) => part.function.name ?? "").join(""),
          arguments: parts.map((part) => part.function.arguments).join(""),
        },
      };
    });

    return {
      id: chunks[0]?.id,
      created: chunks[0]?.created,
      model: chunks[0]?.model,
      content: choices.map((choice) => choice.delta.content ?? "").join(""),
      reasoning: choices.map((choice) => choice.delta.reasoning_content ?? "").join(""),
      refusal: choices.map((choice) => choice.delta.refusal ?? "").join(""),
      calls,
      finish: choices.findLast((choice) => choice.finish_reason !== null)?.finish_reason,
      usage: chunks.find((chunk) => chunk.choices.length === 0)?.usage,
    };
  };

  it.effect.prop(
    "a streamed response assembles into the answer sent without streaming",
    { scenario: Scenario },
    ({ scenario }) =>
      Effect.gen(function* () {
        const events = yield* chatEvents(streamed(scenario), { includeUsage: true });
        const response = yield* Schema.decodeEffect(CompletedResponse)(whole(scenario));
        const answer = toChatCompletion(response);

        expect([assemble(events)]).toEqual(
          answer.choices.map(({ message, finish_reason }) => ({
            id: answer.id,
            created: answer.created,
            model: answer.model,
            content: message.content ?? "",
            reasoning: "reasoning_content" in message ? message.reasoning_content : "",
            refusal: "refusal" in message ? message.refusal : "",
            calls: message.tool_calls ?? [],
            finish: finish_reason,
            usage: answer.usage,
          })),
        );
      }),
  );
});
