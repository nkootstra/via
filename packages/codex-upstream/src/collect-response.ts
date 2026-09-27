import { Effect, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { TERMINAL_EVENTS } from "./terminal-events.ts";

export class UpstreamFailedError extends Schema.TaggedError<UpstreamFailedError>()(
  "UpstreamFailedError",
  { code: Schema.String, reason: Schema.String },
) {
  override get message() {
    return `Codex failed the response (${this.code}): ${this.reason}`;
  }
}

export class IncompleteStreamError extends Schema.TaggedError<IncompleteStreamError>()(
  "IncompleteStreamError",
  {},
) {
  override get message() {
    return "The Codex stream ended before the response completed";
  }
}

const Completed = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Schema.JsonObject,
});

const Failed = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: Schema.Struct({
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
});

const Incomplete = Schema.Struct({
  type: Schema.Literal("response.incomplete"),
  response: Schema.JsonObject,
});

const ItemDone = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Json,
});

const Progress = Schema.Struct({ type: Schema.String });

const StreamEvent = Schema.Union([Completed, Failed, Incomplete, ItemDone, Progress]);

const isCompleted = Schema.is(Completed);

const isFailed = Schema.is(Failed);

const isIncomplete = Schema.is(Incomplete);

const isItemDone = Schema.is(ItemDone);

const isTerminal = (event: typeof StreamEvent.Type) => TERMINAL_EVENTS.has(event.type);

const hasOutput = Schema.is(
  Schema.Struct({ output: Schema.Array(Schema.Json).check(Schema.isMinLength(1)) }),
);

/**
 * Reads a Responses SSE stream to its end and returns the final response
 * object. The Codex backend may leave the final `output` empty, as codex
 * itself expects, so it is rebuilt from the items finished along the way.
 */
export const collectResponse = Effect.fn("collectResponse")(function* <E>(
  body: Stream.Stream<Uint8Array, E>,
) {
  // Only finished items and the terminal event matter; progress events are dropped as they arrive.
  const events = yield* body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    Stream.filter((event) => isItemDone(event) || isTerminal(event)),
    Stream.takeUntil(isTerminal),
    Stream.runCollect,
  );

  // Without a terminal event this is the last finished item, or nothing.
  const event = events.at(-1);

  if (isFailed(event)) {
    const { code, message } = event.response.error;

    return yield* new UpstreamFailedError({ code, reason: message });
  }

  if (isCompleted(event) || isIncomplete(event)) {
    const { response } = event;

    if (hasOutput(response)) return response;

    return { ...response, output: events.filter(isItemDone).map((done) => done.item) };
  }

  return yield* new IncompleteStreamError();
});
