import { Clock, Context, Effect, Option, Ref, Stream } from "effect";
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

const ms = (from: number, to: number) => `${to - from}ms`;

/**
 * Runs `app` for one request and then logs one line about it, such as
 * `POST /v1/responses 200 · gpt-6-astra via a@example.com · 1520ms`. A streamed
 * answer is logged once the stream ends, with when its headers, its first chunk
 * and its end were sent.
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
      const end = yield* Clock.currentTimeMillis;
      const what = Option.match(yield* Ref.get(served), {
        onNone: () => [],
        onSome: ({ model, by }) => [`${model} via ${by}`],
      });
      const first = yield* Ref.get(firstChunk);
      const timing = (yield* Ref.get(streamed))
        ? [
            `headers ${ms(start, yield* Ref.get(headersAt))}`,
            ...Option.toArray(Option.map(first, (at) => `first chunk ${ms(start, at)}`)),
            `done ${ms(start, end)}`,
          ]
        : [ms(start, end)];
      yield* Effect.log(
        [`${request.method} ${request.url} ${yield* Ref.get(status)}`, ...what, ...timing].join(
          " · ",
        ),
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
