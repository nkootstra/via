import {
  isTerminalEvent,
  ResponseCompleted,
  ResponseFailed,
  ResponseIncomplete,
  streamIncomplete,
} from "@via/codex-upstream";
import { Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { chatUsage, finishReason, toolCall, Usage } from "./chat-response.ts";

const Created = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Schema.Struct({ id: Schema.String, created_at: Schema.Finite, model: Schema.String }),
});

const TextDelta = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  delta: Schema.String,
});

const RefusalDelta = Schema.Struct({
  type: Schema.Literal("response.refusal.delta"),
  delta: Schema.String,
});

const ReasoningDelta = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  output_index: Schema.Int,
  summary_index: Schema.Int,
  delta: Schema.String,
});

const FunctionCallAdded = Schema.Struct({
  type: Schema.Literal("response.output_item.added"),
  output_index: Schema.Int,
  item: Schema.Struct({
    type: Schema.Literal("function_call"),
    call_id: Schema.String,
    name: Schema.String,
  }),
});

const ArgumentsDelta = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.delta"),
  output_index: Schema.Int,
  delta: Schema.String,
});

const Completed = Schema.Struct({
  ...ResponseCompleted.fields,
  // Codex may leave the usage out, or send `null`; the answer is no less complete.
  response: Schema.Struct({ usage: Schema.optionalKey(Schema.NullOr(Usage)) }),
});

const Incomplete = Schema.Struct({
  ...ResponseIncomplete.fields,
  response: Schema.Struct({
    incomplete_details: Schema.Struct({ reason: Schema.String }),
    // As with a completed response, Codex may send `null` for the usage.
    usage: Schema.optionalKey(Schema.NullOr(Usage)),
  }),
});

// Item bookkeeping and other events have no Chat Completions counterpart.
const Other = Schema.Struct({ type: Schema.String });

const StreamEvent = Schema.Union([
  Created,
  TextDelta,
  RefusalDelta,
  ReasoningDelta,
  FunctionCallAdded,
  ArgumentsDelta,
  Completed,
  ResponseFailed,
  Incomplete,
  Other,
]);

/**
 * A guard for one kind of event. Every event meets several guards, so it
 * compares the `type` first: a parse that fails costs far more than a miss.
 */
const isEvent = <
  S extends Schema.Top & { readonly fields: { readonly type: Schema.Literal<string> } },
>(
  schema: S,
) => {
  const is = Schema.is(schema);
  const type = schema.fields.type.literal;

  return <E extends { readonly type: string }>(event: E): event is E & S["Type"] =>
    event.type === type && is(event);
};

const isCreated = isEvent(Created);

const isTextDelta = isEvent(TextDelta);

const isRefusalDelta = isEvent(RefusalDelta);

const isReasoningDelta = isEvent(ReasoningDelta);

const isFunctionCallAdded = isEvent(FunctionCallAdded);

const isArgumentsDelta = isEvent(ArgumentsDelta);

const isCompleted = isEvent(Completed);

const isFailed = isEvent(ResponseFailed);

const isIncomplete = isEvent(Incomplete);

const isTerminal = (event: typeof StreamEvent.Type) => isTerminalEvent(event.type);

type State = {
  /** The chunk envelope as JSON, left open for the fields that follow it. */
  readonly envelope: string;
  /** The chat tool call index of each function call, by Responses output index. */
  readonly toolIndex: ReadonlyMap<number, number>;
  /** The reasoning summary part streaming, as `output_index:summary_index`, if one has begun. */
  readonly summaryPart: string | undefined;
  /** Whether the response reached a terminal event. */
  readonly ended: boolean;
};

// Every chunk shares the envelope, so it is serialized once per response
// rather than spread into and stringified with each chunk.
const envelope = (id: string, created: number, model: string) =>
  JSON.stringify({ id, object: "chat.completion.chunk", created, model }).slice(0, -1);

const initial = (): State => ({
  envelope: envelope("", 0, ""),
  toolIndex: new Map(),
  summaryPart: undefined,
  ended: false,
});

const data = (payload: Schema.Json) => `data: ${JSON.stringify(payload)}\n\n`;

const chunk = (state: State, delta: Schema.JsonObject, reason: string | null = null) =>
  `data: ${state.envelope},"choices":[{"index":0,"delta":${JSON.stringify(delta)},"finish_reason":${JSON.stringify(reason)}}]}\n\n`;

// Chat Completions has no failure event; clients such as the openai SDK raise
// an `error` payload sent in place of a chunk.
const failure = (code: string, message: string) =>
  data({ error: { message, type: "server_error", code } });

const incomplete = failure(streamIncomplete.code, streamIncomplete.message);

/**
 * Rewrites a Responses SSE stream into a Chat Completions SSE stream. A
 * response that fails, or a stream that breaks off, ends in an error payload
 * instead of `[DONE]`.
 */
export const toChatStream = <E>(
  body: Stream.Stream<Uint8Array, E>,
  options: { includeUsage: boolean },
) => {
  const step = (state: State, event: typeof StreamEvent.Type): readonly [State, Array<string>] => {
    if (isCreated(event)) {
      const { id, created_at, model } = event.response;
      const next = { ...state, envelope: envelope(id, created_at, model) };

      return [next, [chunk(next, { role: "assistant", content: "" })]];
    }

    if (isTextDelta(event)) return [state, [chunk(state, { content: event.delta })]];

    if (isRefusalDelta(event)) return [state, [chunk(state, { refusal: event.delta })]];

    if (isReasoningDelta(event)) {
      if (event.delta === "") return [state, []];

      const part = `${event.output_index}:${event.summary_index}`;
      // Parts read as paragraphs, as `toChatCompletion` joins them.
      const separator = state.summaryPart === undefined || state.summaryPart === part ? "" : "\n\n";

      return [
        { ...state, summaryPart: part },
        [chunk(state, { reasoning_content: separator + event.delta })],
      ];
    }

    if (isFunctionCallAdded(event)) {
      const index = state.toolIndex.size;
      const toolIndex = new Map(state.toolIndex).set(event.output_index, index);
      const { call_id, name } = event.item;
      const call = { index, ...toolCall(call_id, name, "") };

      return [{ ...state, toolIndex }, [chunk(state, { tool_calls: [call] })]];
    }

    if (isArgumentsDelta(event)) {
      const index = state.toolIndex.get(event.output_index);

      // Arguments for a call the client never saw announced belong to no tool call.
      if (index === undefined) return [state, []];

      return [
        state,
        [chunk(state, { tool_calls: [{ index, function: { arguments: event.delta } }] })],
      ];
    }

    if (isCompleted(event)) {
      return [
        { ...state, ended: true },
        finish(state, finishReason(undefined, state.toolIndex.size > 0), event.response.usage),
      ];
    }

    if (isIncomplete(event)) {
      const { incomplete_details, usage } = event.response;

      return [
        { ...state, ended: true },
        finish(state, finishReason(incomplete_details, state.toolIndex.size > 0), usage),
      ];
    }

    if (isFailed(event)) {
      const { code, message } = event.response.error;

      return [{ ...state, ended: true }, [failure(code, message)]];
    }

    return [state, []];
  };

  const finish = (state: State, reason: string, usage: typeof Usage.Type | null | undefined) => [
    chunk(state, {}, reason),
    ...(options.includeUsage && usage != null
      ? [`data: ${state.envelope},"choices":[],"usage":${JSON.stringify(chatUsage(usage))}}\n\n`]
      : []),
    "data: [DONE]\n\n",
  ];

  return body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    Stream.takeUntil(isTerminal),
    // A read that fails ends the stream here, so `onHalt` reports it once.
    Stream.ignore,
    Stream.mapAccum(initial, step, {
      onHalt: (state) => (state.ended ? [] : [incomplete]),
    }),
    Stream.encodeText,
  );
};
