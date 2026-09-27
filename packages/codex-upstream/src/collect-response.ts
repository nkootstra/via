import { Effect, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import {
  isTerminalEvent,
  ResponseCompleted,
  ResponseFailed,
  ResponseIncomplete,
  streamIncomplete,
} from "./responses-events.ts";

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
    return streamIncomplete.message;
  }
}

const ItemDone = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Json,
});

const Progress = Schema.Struct({ type: Schema.String });

const StreamEvent = Schema.Union([
  ResponseCompleted,
  ResponseFailed,
  ResponseIncomplete,
  ItemDone,
  Progress,
]);

const isCompleted = Schema.is(ResponseCompleted);

const isFailed = Schema.is(ResponseFailed);

const isIncomplete = Schema.is(ResponseIncomplete);

const isItemDone = Schema.is(ItemDone);

const isTerminal = (event: typeof StreamEvent.Type) => isTerminalEvent(event.type);

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
