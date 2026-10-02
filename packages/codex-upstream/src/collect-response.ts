import { Context, Duration, Effect, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { readFailure } from "./rejection.ts";
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

  /** What the failure means for the account that got it. */
  get rejection() {
    return readFailure(this.code, this.reason);
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

/**
 * The most of a stream `collectResponse` reads: 128 MiB. A real response's
 * events, every delta included, come to a few MiB at most; a stream past this
 * never ends. Tests set a smaller one, so as not to stream 128 MiB through via.
 */
export const MaxResponseBytes = Context.Reference<number>("via/MaxResponseBytes", {
  defaultValue: () => 128 * 1024 * 1024,
});

/** How long `collectResponse` waits for a response to complete; a long reasoning run takes minutes. */
const MAX_DURATION = Duration.minutes(30);

export class ResponseTooLargeError extends Schema.TaggedError<ResponseTooLargeError>()(
  "ResponseTooLargeError",
  { maxBytes: Schema.Number },
) {
  override get message() {
    return `The Codex stream ran past ${this.maxBytes / 1024 / 1024} MiB without completing`;
  }
}

export class ResponseTimeoutError extends Schema.TaggedError<ResponseTimeoutError>()(
  "ResponseTimeoutError",
  {},
) {
  override get message() {
    return `The Codex response did not complete within ${Duration.format(MAX_DURATION)}`;
  }
}

/** `body`, failing once it has sent more than `maxBytes`. */
const bounded = <E>(body: Stream.Stream<Uint8Array, E>, maxBytes: number) =>
  body.pipe(
    Stream.mapAccum(
      () => 0,
      (read, chunk): readonly [number, ReadonlyArray<readonly [number, Uint8Array]>] => [
        read + chunk.length,
        [[read + chunk.length, chunk]],
      ],
    ),
    Stream.mapEffect(([read, chunk]) =>
      read > maxBytes
        ? Effect.fail(new ResponseTooLargeError({ maxBytes }))
        : Effect.succeed(chunk),
    ),
  );

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
 * A stream that runs past `MaxResponseBytes` or `MAX_DURATION` without ending fails.
 */
export const collectResponse = Effect.fn("collectResponse")(function* <E>(
  body: Stream.Stream<Uint8Array, E>,
) {
  const maxBytes = yield* MaxResponseBytes;

  // Only finished items and the terminal event matter; progress events are dropped as they arrive.
  const events = yield* bounded(body, maxBytes).pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    Stream.filter((event) => isItemDone(event) || isTerminal(event)),
    Stream.takeUntil(isTerminal),
    Stream.runCollect,
    Effect.timeoutOrElse({
      duration: MAX_DURATION,
      orElse: () => Effect.fail(new ResponseTimeoutError()),
    }),
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
