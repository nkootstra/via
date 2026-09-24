import { Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { chatUsage, incompleteFinish, Usage } from "./chat-response.ts";

const Created = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Schema.Struct({ id: Schema.String, created_at: Schema.Finite, model: Schema.String }),
});
const TextDelta = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
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
  type: Schema.Literal("response.completed"),
  response: Schema.Struct({ usage: Usage }),
});
const Failed = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: Schema.Struct({
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
});
const Incomplete = Schema.Struct({
  type: Schema.Literal("response.incomplete"),
  response: Schema.Struct({
    incomplete_details: Schema.Struct({ reason: Schema.String }),
    usage: Schema.optionalKey(Usage),
  }),
});
// Reasoning, item bookkeeping and other events have no Chat Completions counterpart.
const Other = Schema.Struct({ type: Schema.String });
const StreamEvent = Schema.Union([
  Created,
  TextDelta,
  FunctionCallAdded,
  ArgumentsDelta,
  Completed,
  Failed,
  Incomplete,
  Other,
]);

const isTerminal = (event: typeof StreamEvent.Type) =>
  Schema.is(Completed)(event) || Schema.is(Failed)(event) || Schema.is(Incomplete)(event);

type State = {
  readonly envelope: { id: string; object: string; created: number; model: string };
  /** The chat tool call index of each function call, by Responses output index. */
  readonly toolIndex: ReadonlyMap<number, number>;
  /** Whether the response reached a terminal event. */
  readonly ended: boolean;
};

const initial = (): State => ({
  envelope: { id: "", object: "chat.completion.chunk", created: 0, model: "" },
  toolIndex: new Map(),
  ended: false,
});

const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const chunk = (state: State, delta: object, finishReason: string | null = null) =>
  data({ ...state.envelope, choices: [{ index: 0, delta, finish_reason: finishReason }] });

// Chat Completions has no failure event; clients such as the openai SDK raise
// an `error` payload sent in place of a chunk.
const failure = (code: string, message: string) =>
  data({ error: { message, type: "server_error", code } });

const incomplete = failure(
  "upstream_incomplete",
  "The Codex stream ended before the response completed",
);

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
    if (Schema.is(Created)(event)) {
      const { id, created_at, model } = event.response;
      const next = { ...state, envelope: { ...state.envelope, id, created: created_at, model } };
      return [next, [chunk(next, { role: "assistant", content: "" })]];
    }
    if (Schema.is(TextDelta)(event)) return [state, [chunk(state, { content: event.delta })]];
    if (Schema.is(FunctionCallAdded)(event)) {
      const index = state.toolIndex.size;
      const toolIndex = new Map(state.toolIndex).set(event.output_index, index);
      const { call_id, name } = event.item;
      const call = { index, id: call_id, type: "function", function: { name, arguments: "" } };
      return [{ ...state, toolIndex }, [chunk(state, { tool_calls: [call] })]];
    }
    if (Schema.is(ArgumentsDelta)(event)) {
      const index = state.toolIndex.get(event.output_index) ?? 0;
      return [
        state,
        [chunk(state, { tool_calls: [{ index, function: { arguments: event.delta } }] })],
      ];
    }
    if (Schema.is(Completed)(event)) {
      return [
        { ...state, ended: true },
        finish(state, state.toolIndex.size > 0 ? "tool_calls" : "stop", event.response.usage),
      ];
    }
    if (Schema.is(Incomplete)(event)) {
      const { incomplete_details, usage } = event.response;
      return [
        { ...state, ended: true },
        finish(state, incompleteFinish(incomplete_details.reason), usage),
      ];
    }
    if (Schema.is(Failed)(event)) {
      const { code, message } = event.response.error;
      return [{ ...state, ended: true }, [failure(code, message)]];
    }
    return [state, []];
  };
  const finish = (state: State, reason: string, usage: typeof Usage.Type | undefined) => [
    chunk(state, {}, reason),
    ...(options.includeUsage && usage !== undefined
      ? [data({ ...state.envelope, choices: [], usage: chatUsage(usage) })]
      : []),
    "data: [DONE]\n\n",
  ];
  return body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    Stream.takeUntil(isTerminal),
    Stream.mapAccum(initial, step, {
      onHalt: (state) => (state.ended ? [] : [incomplete]),
    }),
    Stream.orElseSucceed(() => incomplete),
    Stream.encodeText,
  );
};
