import { Clock, Context, Crypto, Effect, Option, Ref, References, Schema, Stream } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

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

/**
 * Global router middleware: gives every request a correlation ID (the client's
 * `x-request-id`, kept when valid, else a fresh UUIDv4), annotates every log made
 * while handling it (so a cooldown warning ties back to its request), and echoes
 * it as `x-request-id` on the response — every route, `/healthz` included, since
 * none is special-cased out. `HttpRouter.serve`'s own `middleware` option cannot
 * change the response that is actually sent, so this has to be a router-level
 * global middleware instead, wrapping each route's effect from the inside.
 *
 * `httpEffect` can fail before it ever produces a `Response` — an unmatched
 * route or method (`HttpServerError.RouteNotFound`), or a route's own defect
 * escaping unconverted — in which case the platform derives the response
 * (a 404, a 500, ...) itself, further up, from the failure. The pre-response
 * handler runs right before that response is sent regardless of whether it
 * came from a success or a failure, so it is the one hook that still lets the
 * header reach the client on that path; the plain `setHeader` below remains
 * for the ordinary success path, since `logRequest` reads the header back off
 * the value this effect resolves with, which the pre-response handler's own
 * response never flows back into.
 */
export const withRequestId = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const id = yield* requestId(request.headers);
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "x-request-id", id)),
      );
      const response = yield* httpEffect.pipe(Effect.annotateLogs({ request_id: id }));
      return HttpServerResponse.setHeader(response, "x-request-id", id);
    }),
  { global: true },
);

/**
 * Runs `app` for one request and then logs it as Effect's own request log does
 * ("Sent HTTP response" in an `http.span`), adding the model, who served it,
 * the request's correlation ID (see `withRequestId`), and, for an error via
 * answers itself, its code and any `Retry-After`. A streamed answer is logged
 * once the stream ends, so `http.span` covers it, with when its headers and its
 * first chunk were sent.
 */
export const logRequest = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const start = yield* Clock.currentTimeMillis;
    const model = yield* Ref.make(Option.none<string>());
    const served = yield* Ref.make(Option.none<string>());
    const refused = yield* Ref.make(Option.none<string>());
    const retryAfter = yield* Ref.make(Option.none<string>());
    const requestIdRef = yield* Ref.make("");
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
          request_id: yield* Ref.get(requestIdRef),
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
      // A host's health checks would drown out the requests.
      Effect.flatMap((left) => (left === 0 && request.url !== "/healthz" ? log : Effect.void)),
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
          // withRequestId, a global router middleware, already set this on `response`.
          Ref.set(requestIdRef, response.headers["x-request-id"] ?? ""),
          Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(headersAt, now)),
        ]),
      ),
      Effect.ensuring(finish),
    );
  });
