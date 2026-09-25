import { Clock, Context, Effect, Option, Ref, References, Stream } from "effect";
import { HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

/** What a request's log line says it asked for and who answered. */
interface Served {
  readonly model: string;
  readonly by: string;
}

/**
 * Notes, for the one line via logs about each request, what the request is
 * for, and times the answer it streams.
 */
export class RequestLog extends Context.Service<
  RequestLog,
  {
    /** Records that `by` (a provider or a Codex account) serves `model`. */
    readonly served: (served: Served) => Effect.Effect<void>;
    /** `stream`, timed: the line waits for it to end and says when its first chunk came. */
    readonly timed: <A, E, R>(
      stream: Stream.Stream<A, E, R>,
    ) => Effect.Effect<Stream.Stream<A, E, R>>;
  }
>()("via/RequestLog") {}

/**
 * Runs `app` for one request and then logs it as Effect's own request log does
 * (`http.span=1520ms: Sent HTTP response`), adding the model and who served it.
 * A streamed answer is logged once the stream ends, so `http.span` covers it,
 * with when its headers and its first chunk were sent.
 */
export const logRequest = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const start = yield* Clock.currentTimeMillis;
    const served = yield* Ref.make(Option.none<Served>());
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
      const what = Option.match(yield* Ref.get(served), {
        onNone: () => ({}),
        onSome: ({ model, by }) => ({ model, served_by: by }),
      });
      yield* Effect.log("Sent HTTP response").pipe(
        Effect.annotateLogs({
          "http.method": request.method,
          "http.url": request.url,
          "http.status": yield* Ref.get(status),
          ...what,
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
      served: (next) => Ref.set(served, Option.some(next)),
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
          Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(headersAt, now)),
        ]),
      ),
      Effect.ensuring(finish),
    );
  });
