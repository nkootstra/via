import { Effect, Option, Schema, Stream } from "effect";

/** Why an upstream refused a request, as far as its answer says: a code and a message. */
export interface UpstreamError {
  readonly code: Option.Option<string>;
  readonly message: Option.Option<string>;
}

/** The longest message kept: enough for any real one, too short to carry much of a request. */
const MESSAGE_LIMIT = 500;

const Text = Schema.NonEmptyString;

/** OpenAI's error, which OpenRouter and OpenCode Go also send: `error.code`, `error.type`, `error.message`. */
const ErrorObject = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optionalKey(Schema.NullOr(Schema.Union([Text, Schema.Finite]))),
    type: Schema.optionalKey(Schema.NullOr(Text)),
    message: Schema.optionalKey(Schema.NullOr(Text)),
  }),
});

/** Codex's error: only a `detail`. */
const Detail = Schema.Struct({ detail: Text });

const decodeErrorObject = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorObject));

const decodeDetail = Schema.decodeUnknownOption(Schema.fromJsonString(Detail));

/** `text` as the usage history keeps a message: trimmed and cut to 500 characters. */
export const cut = (text: string) => text.trim().slice(0, MESSAGE_LIMIT);

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
    const { code, type, message } = object.value.error;

    return {
      code: Option.orElse(Option.map(Option.fromNullishOr(code), String), () => present(type)),
      message: Option.map(present(message), cut),
    };
  }

  const detail = decodeDetail(body);

  if (Option.isSome(detail))
    return { code: Option.none(), message: Option.some(cut(detail.value.detail)) };

  return { code: Option.none(), message: Option.map(present(body), cut) };
};

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
        Stream.onEnd(Effect.suspend(() => report(upstreamErrorOf(text.slice(0, BODY_LIMIT))))),
      );
    }),
  );
