import { ResponsesUsage } from "@via/codex-upstream";
import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";

/** Token counts an upstream reported for one answered request. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  /** The part of `outputTokens` the model spent reasoning. */
  readonly reasoningTokens?: number;
  /** What the upstream says it billed, in USD, as OpenRouter reports in `usage.cost`. */
  readonly costUsd?: number;
}

const ChatUsage = Schema.Struct({
  prompt_tokens: Schema.Finite,
  completion_tokens: Schema.Finite,
  prompt_tokens_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optionalKey(Schema.Finite) })),
  ),
  completion_tokens_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optionalKey(Schema.Finite) })),
  ),
});

const ReportedCost = Schema.Struct({ cost: Schema.Finite });

const isResponsesUsage = Schema.is(ResponsesUsage);

const isChatUsage = Schema.is(ChatUsage);

const isReportedCost = Schema.is(ReportedCost);

/** The counts every usage object has, with the optional ones only when reported. */
const tokenUsage = (
  inputTokens: number,
  outputTokens: number,
  optional: {
    readonly cachedTokens: number | undefined;
    readonly reasoningTokens: number | undefined;
    readonly costUsd: number | undefined;
  },
): TokenUsage => ({
  inputTokens,
  outputTokens,
  ...(optional.cachedTokens === undefined ? {} : { cachedTokens: optional.cachedTokens }),
  ...(optional.reasoningTokens === undefined ? {} : { reasoningTokens: optional.reasoningTokens }),
  ...(optional.costUsd === undefined ? {} : { costUsd: optional.costUsd }),
});

/**
 * Reads token counts out of a Responses `usage` object
 * (`input_tokens`/`output_tokens`, with `cached_tokens` and `reasoning_tokens`
 * in their details) or a Chat Completions one (`prompt_tokens`/
 * `completion_tokens`, likewise), plus the `cost` an upstream such as
 * OpenRouter adds. Anything else is absent, not zero.
 */
export const usageOf = (usage: Schema.Json | undefined): Option.Option<TokenUsage> => {
  const costUsd = isReportedCost(usage) ? usage.cost : undefined;

  if (isResponsesUsage(usage)) {
    return Option.some(
      tokenUsage(usage.input_tokens, usage.output_tokens, {
        cachedTokens: usage.input_tokens_details?.cached_tokens,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
        costUsd,
      }),
    );
  }

  if (isChatUsage(usage)) {
    return Option.some(
      tokenUsage(usage.prompt_tokens, usage.completion_tokens, {
        cachedTokens: usage.prompt_tokens_details?.cached_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        costUsd,
      }),
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
