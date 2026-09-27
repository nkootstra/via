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
  // Codex sends `null` details when it has none to report.
  input_tokens_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optionalKey(Schema.Finite) })),
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
export const usageOf = (usage: Schema.Json | undefined): Option.Option<TokenUsage> => {
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
  response: Schema.optionalKey(Schema.Struct({ usage: Schema.optionalKey(Schema.Json) })),
  usage: Schema.optionalKey(Schema.Json),
});

const usageFromPayload = (payload: typeof EventPayload.Type): Option.Option<TokenUsage> =>
  Option.orElse(usageOf(payload.response?.usage), () => usageOf(payload.usage));

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(EventPayload));

/**
 * The usage a raw JSON chunk of text carries, if any — never a decode failure.
 * Text without a `"usage"` key can't carry any, so it isn't parsed: most SSE
 * events of an answer are deltas without one.
 */
const usageIn = (text: string): Option.Option<TokenUsage> =>
  text.includes('"usage"') ? Option.flatMap(decodePayload(text), usageFromPayload) : Option.none();

/** Reports each usage found, then passes `chunks` on; no effect runs when none was found. */
const reportAll = <A>(
  found: ReadonlyArray<TokenUsage>,
  report: (usage: TokenUsage) => Effect.Effect<void>,
  chunks: A,
): Effect.Effect<A> =>
  found.length === 0
    ? Effect.succeed(chunks)
    : Effect.as(Effect.forEach(found, report, { discard: true }), chunks);

/**
 * Taps a Server-Sent Events byte stream for the usage a `response.completed`
 * Responses event, or a Chat Completions final chunk, carries — bytes pass
 * through completely unchanged. A malformed event is silently skipped.
 */
const spotSse = <E>(
  body: Stream.Stream<Uint8Array, E>,
  report: (usage: TokenUsage) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> =>
  // Built fresh inside `Effect.sync` so each *run* of the returned stream (not
  // each call to `spotSse`) gets its own decoder/parser — a Stream is a
  // repeatable description, and must be safe to run more than once.
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder();
      let found: Array<TokenUsage> = [];

      const parser = Sse.makeParser((event) => {
        if (Sse.Retry.is(event)) return;
        const usage = usageIn(event.data);

        if (Option.isSome(usage)) found.push(usage.value);
      });

      return body.pipe(
        Stream.mapArrayEffect((chunks) => {
          for (const chunk of chunks) parser.feed(decoder.decode(chunk, { stream: true }));
          const spotted = found;
          found = [];

          return reportAll(spotted, report, chunks);
        }),
      );
    }),
  );

/**
 * Taps a JSON body byte stream for the `usage` it carries once it is
 * complete — bytes pass through completely unchanged. A body that never
 * parses, or never carries usage, reports nothing.
 */
const spotJson = <E>(
  body: Stream.Stream<Uint8Array, E>,
  report: (usage: TokenUsage) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> =>
  // Same reason as `spotSse`: a fresh decoder/buffer per run, not per call.
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder();
      let text = "";

      return body.pipe(
        Stream.mapArray((chunks) => {
          for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });

          return chunks;
        }),
        // Parsed once, when the body is complete, not again with every chunk.
        Stream.onEnd(
          Effect.suspend(() => {
            text += decoder.decode();

            return reportAll(Option.toArray(usageIn(text)), report, undefined);
          }),
        ),
      );
    }),
  );

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
