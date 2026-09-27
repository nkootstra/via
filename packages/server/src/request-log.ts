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
const noted = (key: string, value: Option.Option<string>) =>
  Option.match(value, { onNone: () => ({}), onSome: (text) => ({ [key]: text }) });

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
    const model = yield* Ref.make(Option.none<string>());
    const served = yield* Ref.make(Option.none<string>());
    const refused = yield* Ref.make(Option.none<string>());
    const usage = yield* Ref.make(Option.none<TokenUsage>());
    const retryAfter = yield* Ref.make(Option.none<string>());
    const streamed = yield* Ref.make(false);
    const firstChunk = yield* Ref.make(Option.none<number>());
    const ended = yield* Ref.make(Option.none<string>());
    // The line waits for both the response and, when there is one, its stream.
    const pending = yield* Ref.make(1);
    const status = yield* Ref.make(0);
    const headersAt = yield* Ref.make(start);

    const log = Effect.gen(function* () {
      const headers = (yield* Ref.get(headersAt)) - start;
      const first = yield* Ref.get(firstChunk);

      const timings = (yield* Ref.get(streamed))
        ? {
            headers_ms: headers,
            ...Option.match(first, {
              onNone: () => ({}),
              onSome: (at) => ({ first_chunk_ms: at - start }),
            }),
            ...noted("stream_end", yield* Ref.get(ended)),
          }
        : {};

      yield* Effect.log("Sent HTTP response").pipe(
        Effect.annotateLogs({
          request_id: id,
          "http.method": request.method,
          "http.url": request.url,
          "http.status": yield* Ref.get(status),
          ...noted("model", yield* Ref.get(model)),
          ...noted("served_by", yield* Ref.get(served)),
          ...noted("error", yield* Ref.get(refused)),
          ...noted("retry_after", yield* Ref.get(retryAfter)),
          ...usageAnnotations(yield* Ref.get(usage)),
          ...timings,
        }),
        // As Effect's own request log does, but the span lasts until the answer is sent.
        Effect.provideService(References.CurrentLogSpans, [["http.span", start]]),
      );
    });

    const finish = Ref.updateAndGet(pending, (n) => n - 1).pipe(
      // A host's health checks would drown out the requests.
      Effect.flatMap((left) => (left === 0 && request.url !== "/healthz" ? log : Effect.void)),
    );

    const service = RequestLog.of({
      asked: (name) => Ref.set(model, Option.some(name)),
      served: (by) => Ref.set(served, Option.some(by)),
      refused: (code) => Ref.set(refused, Option.some(code)),
      usage: (found) => Ref.set(usage, Option.some(found)),
      timed: (stream) =>
        Effect.as(
          Effect.all([Ref.set(streamed, true), Ref.update(pending, (n) => n + 1)]),
          stream.pipe(
            // Only the first chunk is timed; `tap` would run an effect for every chunk.
            Stream.onFirst(() =>
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                Ref.set(firstChunk, Option.some(now)),
              ),
            ),
            Stream.onExit((exit) =>
              Effect.andThen(Ref.set(ended, Option.some(streamEnd(exit))), finish),
            ),
            // Bun prints the error a response body fails with, stack and request included.
            // Failing with `undefined` still cuts the client off, so a truncated answer never
            // looks complete, but quietly: this line already says the stream failed.
            Stream.mapError(() => undefined),
          ),
        ),
    });

    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.as(
        Effect.all([
          Ref.set(status, response.status),
          Ref.set(retryAfter, Option.fromNullishOr(response.headers["retry-after"])),
          Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(headersAt, now)),
        ]),
        HttpServerResponse.setHeader(response, "x-request-id", id),
      ),
    );

    return yield* app.pipe(
      Effect.provideService(RequestLog, service),
      Effect.annotateLogs({ request_id: id }),
      Effect.ensuring(finish),
    );
  });
