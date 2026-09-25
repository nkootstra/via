import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";

/** Token counts an upstream reported for one answered request. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
}

const ResponsesUsage = Schema.Struct({
  input_tokens: Schema.Finite,
  output_tokens: Schema.Finite,
  input_tokens_details: Schema.optionalKey(
    Schema.Struct({ cached_tokens: Schema.optionalKey(Schema.Finite) }),
  ),
});
const ChatUsage = Schema.Struct({
  prompt_tokens: Schema.Finite,
  completion_tokens: Schema.Finite,
  prompt_tokens_details: Schema.optionalKey(
    Schema.Struct({ cached_tokens: Schema.optionalKey(Schema.Finite) }),
  ),
});
const isResponsesUsage = Schema.is(ResponsesUsage);
const isChatUsage = Schema.is(ChatUsage);

const withCached = (
  usage: { inputTokens: number; outputTokens: number },
  cachedTokens: number | undefined,
): TokenUsage => (cachedTokens === undefined ? usage : { ...usage, cachedTokens });

/**
 * Reads token counts out of a Responses `usage` object
 * (`input_tokens`/`output_tokens`/`input_tokens_details.cached_tokens`) or a
 * Chat Completions one (`prompt_tokens`/`completion_tokens`/
 * `prompt_tokens_details.cached_tokens`). Anything else is absent, not zero.
 */
export const usageOf = (usage: unknown): Option.Option<TokenUsage> => {
  if (isResponsesUsage(usage)) {
    return Option.some(
      withCached(
        { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
        usage.input_tokens_details?.cached_tokens,
      ),
    );
  }
  if (isChatUsage(usage)) {
    return Option.some(
      withCached(
        { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens },
        usage.prompt_tokens_details?.cached_tokens,
      ),
    );
  }
  return Option.none();
};

// The shape of a Responses SSE event, or a Chat Completions body/final SSE
// chunk, permissive enough to match either without caring about the rest.
const EventPayload = Schema.Struct({
  response: Schema.optionalKey(Schema.Struct({ usage: Schema.optionalKey(Schema.Unknown) })),
  usage: Schema.optionalKey(Schema.Unknown),
});

const usageFromPayload = (payload: typeof EventPayload.Type): Option.Option<TokenUsage> => {
  const nested = payload.response?.usage;
  return nested === undefined
    ? usageOf(payload.usage)
    : Option.orElse(usageOf(nested), () => usageOf(payload.usage));
};

const decodePayload = Schema.decodeEffect(Schema.fromJsonString(EventPayload));

/** The usage a raw JSON chunk of text carries, if any — never a decode failure. */
const usageIn = (text: string): Effect.Effect<Option.Option<TokenUsage>> =>
  decodePayload(text).pipe(
    Effect.map(usageFromPayload),
    Effect.orElseSucceed(() => Option.none()),
  );

const reportIfSome = (
  found: Option.Option<TokenUsage>,
  report: (usage: TokenUsage) => Effect.Effect<void>,
) => Option.match(found, { onNone: () => Effect.void, onSome: report });

/**
 * Taps a Server-Sent Events byte stream for the usage a `response.completed`
 * Responses event, or a Chat Completions final chunk, carries — bytes pass
 * through completely unchanged. A malformed event is silently skipped.
 */
const spotSse = <E>(
  body: Stream.Stream<Uint8Array, E>,
  report: (usage: TokenUsage) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> => {
  const decoder = new TextDecoder();
  let pending: Array<string> = [];
  const parser = Sse.makeParser((event) => {
    if (!Sse.Retry.is(event)) pending.push(event.data);
  });
  return body.pipe(
    Stream.mapEffect((chunk) => {
      parser.feed(decoder.decode(chunk, { stream: true }));
      const events = pending;
      pending = [];
      return Effect.forEach(
        events,
        (data) => Effect.flatMap(usageIn(data), (found) => reportIfSome(found, report)),
        { discard: true },
      ).pipe(Effect.as(chunk));
    }),
  );
};

/**
 * Taps a JSON body byte stream for the `usage` it carries once it is
 * complete — bytes pass through completely unchanged. A body that never
 * parses, or never carries usage, reports nothing.
 */
const spotJson = <E>(
  body: Stream.Stream<Uint8Array, E>,
  report: (usage: TokenUsage) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> => {
  const decoder = new TextDecoder();
  let text = "";
  let reported = false;
  return body.pipe(
    Stream.mapEffect((chunk) => {
      text += decoder.decode(chunk, { stream: true });
      if (reported) return Effect.succeed(chunk);
      return Effect.flatMap(usageIn(text), (found) =>
        Effect.as(
          reportIfSome(found, report).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                reported = Option.isSome(found);
              }),
            ),
          ),
          chunk,
        ),
      );
    }),
  );
};

/**
 * Taps a response body byte stream for the token usage it reports — an SSE
 * stream's `response.completed`/final chunk, or a complete JSON body — and
 * calls `report` the moment one is spotted. The bytes pass through
 * completely unchanged, and a malformed event never breaks the stream.
 */
export const spotUsage = <E>(
  body: Stream.Stream<Uint8Array, E>,
  sse: boolean,
  report: (usage: TokenUsage) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> => (sse ? spotSse(body, report) : spotJson(body, report));
