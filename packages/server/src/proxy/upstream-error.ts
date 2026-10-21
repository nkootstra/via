import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";

/**
 * Why an upstream refused a request, as far as its answer says: a code and a message,
 * and, from a router such as OpenRouter, the provider it sent the request on to.
 */
export interface UpstreamError {
  readonly code: Option.Option<string>;
  readonly message: Option.Option<string>;
  readonly downstreamProvider: Option.Option<string>;
  /** The answer's body, as far as via read it, for a captured request; never logged. */
  readonly body?: string;
}

/** The longest message passed on: enough for any real one, too short to carry much of a request. */
const MESSAGE_LIMIT = 500;

const Text = Schema.NonEmptyString;

/** OpenAI's error, which OpenRouter and OpenCode Go also send: `error.code`, `error.type`, `error.message`. */
const ErrorObject = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optionalKey(Schema.NullOr(Schema.Union([Text, Schema.Finite]))),
    type: Schema.optionalKey(Schema.NullOr(Text)),
    message: Schema.optionalKey(Schema.NullOr(Text)),
    /** OpenRouter's detail, such as `provider_name`; the rest of it is the provider's. */
    metadata: Schema.optionalKey(Schema.Json),
  }),
});

/**
 * A provider's name as a router gives it, such as `Google AI Studio`: words, not
 * text that could quote the request.
 */
const ProviderName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][\w .()-]{0,63}$/));

const decodeDownstream = Schema.decodeUnknownOption(Schema.Struct({ provider_name: ProviderName }));

/** Codex's error: only a `detail`. */
const Detail = Schema.Struct({ detail: Text });

const decodeErrorObject = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorObject));

const decodeDetail = Schema.decodeUnknownOption(Schema.fromJsonString(Detail));

/** `text` as via passes a message on: trimmed and cut to 500 characters. */
const cut = (text: string) => text.trim().slice(0, MESSAGE_LIMIT);

const present = (text: string | null | undefined) =>
  Option.filter(Option.fromNullishOr(text), (found) => found.trim() !== "");

/**
 * Why an upstream refused a request, read from its answer's body: an
 * OpenAI-style `error` object, Codex's `detail`, or, for a body neither, the
 * body itself as the message. A message is cut to 500 characters.
 */
export const upstreamErrorOf = (body: string): UpstreamError => {
  const object = decodeErrorObject(body);

  if (Option.isSome(object)) {
    const { code, type, message, metadata } = object.value.error;

    return {
      code: Option.orElse(Option.map(Option.fromNullishOr(code), String), () => present(type)),
      message: Option.map(present(message), cut),
      downstreamProvider: Option.map(decodeDownstream(metadata), (found) => found.provider_name),
    };
  }

  const detail = decodeDetail(body);

  if (Option.isSome(detail))
    return {
      code: Option.none(),
      message: Option.some(cut(detail.value.detail)),
      downstreamProvider: Option.none(),
    };

  return {
    code: Option.none(),
    message: Option.map(present(body), cut),
    downstreamProvider: Option.none(),
  };
};

/** The most of an error body kept for a captured request: a real one is far shorter. */
const KEPT_BODY_LIMIT = 64 * 1024;

/**
 * Why an upstream refused a request, as `upstreamErrorOf` reads it, with the body it was
 * read from, cut to 64 KiB, for a captured request.
 */
export const refusalOf = (body: string): UpstreamError => ({
  ...upstreamErrorOf(body),
  body: body.slice(0, KEPT_BODY_LIMIT),
});

/** The most of an error body read for its cause: a real one is far shorter. */
const BODY_LIMIT = 16_384;

/**
 * Taps an error answer's body for why the upstream refused the request, and
 * calls `report` once it is complete. The bytes pass through unchanged; past
 * 16 KiB, the rest is passed on unread.
 */
export const spotUpstreamError = <E>(
  body: Stream.Stream<Uint8Array, E>,
  report: (error: UpstreamError) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> =>
  // Built fresh for each run of the stream, as `spotUsage` is.
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder();
      let text = "";

      return body.pipe(
        Stream.mapArray((chunks) => {
          for (const chunk of chunks) {
            if (text.length < BODY_LIMIT) text += decoder.decode(chunk, { stream: true });
          }

          return chunks;
        }),
        Stream.onEnd(Effect.suspend(() => report(refusalOf(text.slice(0, BODY_LIMIT))))),
      );
    }),
  );

const StreamFailure = Schema.Union([
  ErrorObject,
  Schema.Struct({ type: Schema.Literal("error"), code: Schema.String, message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("response.failed"),
    response: ErrorObject,
  }),
]);

const decodeStreamFailure = Schema.decodeUnknownOption(Schema.fromJsonString(StreamFailure));

/** Records SSE failures after translation, including an error emitted for a cut-off stream. */
export const spotStreamError = <E>(
  body: Stream.Stream<Uint8Array, E>,
  report: (error: UpstreamError) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> =>
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder();
      let found: Array<UpstreamError> = [];

      const parser = Sse.makeParser((event) => {
        if (Sse.Retry.is(event)) return;

        for (const error of Option.toArray(decodeStreamFailure(event.data))) {
          const payload =
            "response" in error ? error.response : "error" in error ? error : { error };

          found.push(refusalOf(JSON.stringify(payload)));
        }
      });

      return body.pipe(
        Stream.mapArrayEffect((chunks) => {
          for (const chunk of chunks) parser.feed(decoder.decode(chunk, { stream: true }));
          const failures = found;
          found = [];

          return Effect.as(Effect.forEach(failures, report, { discard: true }), chunks);
        }),
      );
    }),
  );
