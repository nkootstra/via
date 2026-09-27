import {
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  Option,
  Ref,
  References,
  Schema,
  Stream,
} from "effect";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { TokenUsage } from "./token-usage.ts";

/**
 * Notes, for the one line via logs about each request, what the request is
 * for, and times the answer it streams.
 */
export class RequestLog extends Context.Service<
  RequestLog,
  {
    /** Records the model the request asks for. */
    readonly asked: (model: string) => Effect.Effect<void>;
    /** Records that `by`, a provider or a Codex account, serves the request. */
    readonly served: (by: string) => Effect.Effect<void>;
    /** Records the error code of an answer via gives itself, such as `rate_limit_exceeded`. */
    readonly refused: (code: string) => Effect.Effect<void>;
    /** Records the token usage the upstream reported for the answer. */
    readonly usage: (usage: TokenUsage) => Effect.Effect<void>;
    /**
     * `stream`, timed: the line waits for it to end and says when its first chunk came.
     * It still fails as `stream` does, but without its error, which Bun would print.
     */
    readonly timed: <A, E, R>(
      stream: Stream.Stream<A, E, R>,
    ) => Effect.Effect<Stream.Stream<A, undefined, R>>;
  }
>()("via/RequestLog") {}

/** `{ [key]: value }` for a value that was noted, else nothing. */
const noted = <A>(key: string, value: Option.Option<A>) =>
  Option.match(value, { onNone: () => ({}), onSome: (found) => ({ [key]: found }) });

/**
 * How a streamed answer ended: sent in full, stopped by the client going away
 * (which interrupts the stream), or broken off by an error, such as the
 * upstream dropping the connection.
 */
const streamEnd = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? "completed"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "client_aborted"
      : "failed";

/** A textual UUID (any version), the shape a client's `x-request-id` must have to be kept. */
const RequestIdHeader = Schema.String.pipe(Schema.check(Schema.isUUID()));

/**
 * The request's correlation ID: the client's `x-request-id` header, lower-cased,
 * when it is a single valid UUID, else a fresh UUIDv4. A repeated header arrives
 * here already joined with ", " by `Headers`, which fails the UUID shape just
 * like any other malformed value, so it falls to a fresh ID without special-casing.
 */
const requestId = (headers: Record<string, string>) =>
  Effect.gen(function* () {
    const sent = Schema.decodeUnknownOption(RequestIdHeader)(headers["x-request-id"]);

    if (Option.isSome(sent)) return sent.value.toLowerCase();
    const crypto = yield* Crypto.Crypto;

    // A true infra fault (the platform's entropy source failing); no per-request fallback applies.
    return yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  });

/** The usage annotations for a request's log line — absent when none was reported. */
const usageAnnotations = (usage: Option.Option<TokenUsage>) =>
  Option.match(usage, {
    onNone: () => ({}),
    onSome: (u) => ({
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      ...(u.cachedTokens === undefined ? {} : { cached_tokens: u.cachedTokens }),
    }),
  });

/** What a request's log line says, noted while the request is handled. */
interface Noted {
  readonly model: Option.Option<string>;
  readonly servedBy: Option.Option<string>;
  readonly error: Option.Option<string>;
  readonly usage: Option.Option<TokenUsage>;
  readonly retryAfter: Option.Option<string>;
  readonly status: number;
  readonly headersAt: number;
  readonly streamed: boolean;
  readonly firstChunkAt: Option.Option<number>;
  readonly streamEnd: Option.Option<string>;
  /** The line waits for both the response and, once it runs, its stream. */
  readonly pending: number;
}

/**
 * Runs `app` for one request and then logs it as Effect's own request log does
 * ("Sent HTTP response" in an `http.span`), adding the model, who served it,
 * and, for an error via answers itself, its code and any `Retry-After`. A
 * streamed answer is logged once the stream ends, so `http.span` covers it,
 * with when its headers and its first chunk were sent.
 *
 * It also gives every request a correlation ID (see `requestId`), which
 * annotates every log made while handling it, so a cooldown warning ties back
 * to its request, and goes back as `x-request-id`. Both the header and the
 * status are taken in a pre-response handler: that runs on the response
 * actually sent, including one the platform derives from a failure, such as
 * a 404 for no matching route or a 500 for a defect.
 */
export const logRequest = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = yield* requestId(request.headers);
    const start = yield* Clock.currentTimeMillis;

    const noting = yield* Ref.make<Noted>({
      model: Option.none(),
      servedBy: Option.none(),
      error: Option.none(),
      usage: Option.none(),
      retryAfter: Option.none(),
      status: 0,
      headersAt: start,
      streamed: false,
      firstChunkAt: Option.none(),
      streamEnd: Option.none(),
      pending: 1,
    });

    const note = (found: Partial<Noted>) => Ref.update(noting, (sofar) => ({ ...sofar, ...found }));

    const log = (line: Noted) =>
      Effect.log("Sent HTTP response").pipe(
        Effect.annotateLogs({
          request_id: id,
          "http.method": request.method,
          "http.url": request.url,
          "http.status": line.status,
          ...noted("model", line.model),
          ...noted("served_by", line.servedBy),
          ...noted("error", line.error),
          ...noted("retry_after", line.retryAfter),
          ...usageAnnotations(line.usage),
          ...(line.streamed
            ? {
                headers_ms: line.headersAt - start,
                ...noted(
                  "first_chunk_ms",
                  Option.map(line.firstChunkAt, (at) => at - start),
                ),
                ...noted("stream_end", line.streamEnd),
              }
            : {}),
        }),
        // As Effect's own request log does, but the span lasts until the answer is sent.
        Effect.provideService(References.CurrentLogSpans, [["http.span", start]]),
      );

    const finish = Ref.modify(noting, (sofar): [Noted, Noted] => {
      const line = { ...sofar, pending: sofar.pending - 1 };

      return [line, line];
    }).pipe(
      // A host's health checks would drown out the requests.
      Effect.flatMap((line) =>
        line.pending === 0 && request.url !== "/healthz" ? log(line) : Effect.void,
      ),
    );

    const service = RequestLog.of({
      asked: (model) => note({ model: Option.some(model) }),
      served: (by) => note({ servedBy: Option.some(by) }),
      refused: (code) => note({ error: Option.some(code) }),
      usage: (usage) => note({ usage: Option.some(usage) }),
      timed: (stream) =>
        Effect.succeed(
          // The line waits for the stream only once it runs: a response sent without its body,
          // such as a 204, never runs it. The server starts it as it sends the response, which
          // is before `app` ends, so the request cannot write the line while the stream runs.
          Stream.unwrap(
            Effect.as(
              Effect.acquireRelease(
                Ref.update(noting, (sofar) => ({
                  ...sofar,
                  streamed: true,
                  pending: sofar.pending + 1,
                })),
                (_, exit) =>
                  Effect.andThen(note({ streamEnd: Option.some(streamEnd(exit)) }), finish),
              ),
              // Only the first chunk is timed; `tap` would run an effect for every chunk.
              Stream.onFirst(stream, () =>
                Effect.flatMap(Clock.currentTimeMillis, (now) =>
                  note({ firstChunkAt: Option.some(now) }),
                ),
              ),
            ),
          ).pipe(
            // Bun prints the error a response body fails with, stack and request included.
            // Failing with `undefined` still cuts the client off, so a truncated answer never
            // looks complete, but quietly: this line already says the stream failed.
            Stream.mapError(() => undefined),
          ),
        ),
    });

    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        note({
          status: response.status,
          retryAfter: Option.fromNullishOr(response.headers["retry-after"]),
          headersAt: now,
        }),
      ).pipe(Effect.as(HttpServerResponse.setHeader(response, "x-request-id", id))),
    );

    return yield* app.pipe(
      Effect.provideService(RequestLog, service),
      Effect.annotateLogs({ request_id: id }),
      Effect.ensuring(finish),
    );
  });
