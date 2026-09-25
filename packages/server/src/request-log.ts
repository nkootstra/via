import { Clock, Context, Effect, Option, Ref, References, Stream } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

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
    /** `stream`, timed: the line waits for it to end and says when its first chunk came. */
    readonly timed: <A, E, R>(
      stream: Stream.Stream<A, E, R>,
    ) => Effect.Effect<Stream.Stream<A, E, R>>;
  }
>()("via/RequestLog") {}

/** `{ [key]: value }` for a value that was noted, else nothing. */
const noted = (key: string, value: Option.Option<string>) =>
  Option.match(value, { onNone: () => ({}), onSome: (text) => ({ [key]: text }) });

/**
 * Runs `app` for one request and then logs it as Effect's own request log does
 * (`http.span=1520ms: Sent HTTP response`), adding the model, who served it
 * and, for an error via answers itself, its code and any `Retry-After`.
 * A streamed answer is logged once the stream ends, so `http.span` covers it,
 * with when its headers and its first chunk were sent.
 */
export const logRequest = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const start = yield* Clock.currentTimeMillis;
    const model = yield* Ref.make(Option.none<string>());
    const served = yield* Ref.make(Option.none<string>());
    const refused = yield* Ref.make(Option.none<string>());
    const retryAfter = yield* Ref.make(Option.none<string>());
    const streamed = yield* Ref.make(false);
    const firstChunk = yield* Ref.make(Option.none<number>());
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
          }
        : {};
      yield* Effect.log("Sent HTTP response").pipe(
        Effect.annotateLogs({
          "http.method": request.method,
          "http.url": request.url,
          "http.status": yield* Ref.get(status),
          ...noted("model", yield* Ref.get(model)),
          ...noted("served_by", yield* Ref.get(served)),
          ...noted("error", yield* Ref.get(refused)),
          ...noted("retry_after", yield* Ref.get(retryAfter)),
          ...timings,
        }),
        // As Effect's own request log does, but the span lasts until the answer is sent.
        Effect.provideService(References.CurrentLogSpans, [["http.span", start]]),
      );
    });
    const finish = Ref.updateAndGet(pending, (n) => n - 1).pipe(
      Effect.flatMap((left) => (left === 0 ? log : Effect.void)),
    );

    const service = RequestLog.of({
      asked: (name) => Ref.set(model, Option.some(name)),
      served: (by) => Ref.set(served, Option.some(by)),
      refused: (code) => Ref.set(refused, Option.some(code)),
      timed: (stream) =>
        Effect.as(
          Effect.all([Ref.set(streamed, true), Ref.update(pending, (n) => n + 1)]),
          stream.pipe(
            Stream.tap(() =>
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                Ref.update(
                  firstChunk,
                  Option.orElse(() => Option.some(now)),
                ),
              ),
            ),
            Stream.ensuring(finish),
          ),
        ),
    });

    return yield* app.pipe(
      Effect.provideService(RequestLog, service),
      Effect.tap((response) =>
        Effect.all([
          Ref.set(status, response.status),
          Ref.set(retryAfter, Option.fromNullishOr(response.headers["retry-after"])),
          Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(headersAt, now)),
        ]),
      ),
      Effect.ensuring(finish),
    );
  });
