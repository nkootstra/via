import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";

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
  response: Schema.Record(Schema.String, Schema.Unknown),
});
const Failed = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: Schema.Struct({
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
});
const Progress = Schema.Struct({ type: Schema.String });
const StreamEvent = Schema.Union([Completed, Failed, Progress]);

const isTerminal = (event: typeof StreamEvent.Type) =>
  Schema.is(Completed)(event) || Schema.is(Failed)(event);

/** Reads a Responses SSE stream to its end and returns the final response object. */
export const collectResponse = Effect.fn("collectResponse")(function* <E>(
  body: Stream.Stream<Uint8Array, E>,
) {
  const terminal = yield* body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    Stream.filter(isTerminal),
    Stream.runHead,
  );
  if (Option.isNone(terminal)) return yield* new IncompleteStreamError();
  const event = terminal.value;
  if (Schema.is(Failed)(event)) {
    const { code, message } = event.response.error;
    return yield* new UpstreamFailedError({ code, reason: message });
  }
  return event.response;
});
