import { Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { chatUsage, Usage } from "./chat-response.ts";

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
// Reasoning, item bookkeeping and other events have no Chat Completions counterpart.
const Other = Schema.Struct({ type: Schema.String });
const StreamEvent = Schema.Union([
  Created,
  TextDelta,
  FunctionCallAdded,
  ArgumentsDelta,
  Completed,
  Other,
]);

type State = {
  readonly envelope: { id: string; object: string; created: number; model: string };
  /** The chat tool call index of each function call, by Responses output index. */
  readonly toolIndex: ReadonlyMap<number, number>;
};

const initial = (): State => ({
  envelope: { id: "", object: "chat.completion.chunk", created: 0, model: "" },
  toolIndex: new Map(),
});

const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const chunk = (state: State, delta: object, finishReason: string | null = null) =>
  data({ ...state.envelope, choices: [{ index: 0, delta, finish_reason: finishReason }] });

/** Rewrites a Responses SSE stream into a Chat Completions SSE stream. */
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
      const finish = chunk(state, {}, state.toolIndex.size > 0 ? "tool_calls" : "stop");
      const usage = options.includeUsage
        ? [data({ ...state.envelope, choices: [], usage: chatUsage(event.response.usage) })]
        : [];
      return [state, [finish, ...usage, "data: [DONE]\n\n"]];
    }
    return [state, []];
  };
  return body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    Stream.mapAccum(initial, step),
    Stream.encodeText,
  );
};
