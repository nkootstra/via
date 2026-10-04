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
import { UsageHistory } from "@via/usage";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { UsageEntry } from "@via/usage";
import type { TokenUsage } from "./token-usage.ts";
import type { UpstreamError } from "./upstream-error.ts";

/**
 * Notes, for the one line via logs about each request, what the request is
 * for, and times the answer it streams.
 */
export class RequestLog extends Context.Service<
  RequestLog,
  {
    /** Records the API key the client presented. */
    readonly key: (key: ClientKey) => Effect.Effect<void>;
    /** Records the model the request asks for, and whether it asks for its answer as a stream. */
    readonly asked: (model: string, stream: boolean) => Effect.Effect<void>;
    /**
     * Records that `by`, a provider or an account's label, serves the request,
     * with the account's id when an account of a pool serves it.
     */
    readonly served: (by: string, accountId?: string) => Effect.Effect<void>;
    /** Records the error code of an answer via gives itself, such as `rate_limit_exceeded`. */
    readonly refused: (code: string, message: string) => Effect.Effect<void>;
    /** Records why an upstream refused the request, as its answer says. */
    readonly upstreamFailed: (error: UpstreamError) => Effect.Effect<void>;
    /** Records the token usage the upstream reported for the answer. */
    readonly usage: (usage: TokenUsage) => Effect.Effect<void>;
    /** Leaves the request out of the log, as a file a page fetches with it. */
    readonly unlogged: Effect.Effect<void>;
    /**
     * `stream`, timed: the line waits for it to end and says when its first chunk came.
     * It still fails as `stream` does, but without its error, which Bun would print.
     */
    readonly timed: <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, undefined, R>;
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
      ...(u.cacheWriteTokens === undefined ? {} : { cache_write_tokens: u.cacheWriteTokens }),
      ...(u.reasoningTokens === undefined ? {} : { reasoning_tokens: u.reasoningTokens }),
      ...(u.costUsd === undefined ? {} : { cost_usd: u.costUsd }),
    }),
  });

/** The API key a client presented: its id, and its name as it is now. */
export interface ClientKey {
  readonly id: string;
  readonly name: string;
}

/**
 * Whether a request's answer went out as a stream the client asked for. A
 * request that asked for no model, such as the admin UI's event stream, counts
 * its streamed answer as one.
 */
const streamedAnswer = (line: Noted) =>
  line.streamed && Option.getOrElse(line.streamAsked, () => true);

/** The upstream a model goes to: the provider it is prefixed with, else Codex. */
const providerOf = (model: string) => {
  const slash = model.indexOf("/");

  return slash === -1 ? "codex" : model.slice(0, slash);
};

/** The usage-history entry for a request that asked for `model`, as `line` noted it. */
const entryOf = (
  id: string,
  start: number,
  end: number,
  model: string,
  line: Noted,
): UsageEntry => {
  const usage = line.usage;

  const count = (read: (u: TokenUsage) => number | undefined) =>
    Option.flatMap(usage, (u) => Option.fromUndefinedOr(read(u)));

  return {
    requestId: id,
    at: start,
    status: line.status,
    error: Option.orElse(line.error, () =>
      Option.flatMap(line.upstreamError, (upstream) => upstream.code),
    ),
    errorMessage: Option.orElse(line.errorMessage, () =>
      Option.flatMap(line.upstreamError, (upstream) => upstream.message),
    ),
    streamEnd: streamedAnswer(line) ? line.streamEnd : Option.none(),
    keyId: Option.map(line.key, (key) => key.id),
    keyName: Option.map(line.key, (key) => key.name),
    model,
    provider: providerOf(model),
    accountId: line.accountId,
    accountLabel: Option.flatMap(line.accountId, () => line.servedBy),
    inputTokens: count((u) => u.inputTokens),
    cachedTokens: count((u) => u.cachedTokens),
    cacheWriteTokens: count((u) => u.cacheWriteTokens),
    outputTokens: count((u) => u.outputTokens),
    reasoningTokens: count((u) => u.reasoningTokens),
    costUsd: count((u) => u.costUsd),
    durationMs: end - start,
    firstChunkMs: streamedAnswer(line)
      ? Option.map(line.firstChunkAt, (at) => at - start)
      : Option.none(),
  };
};

/** What a request's log line says, noted while the request is handled. */
interface Noted {
  readonly key: Option.Option<ClientKey>;
  readonly model: Option.Option<string>;
  /**
   * Whether the client asked for a stream. via relays a provider's answer as a
   * stream either way, but only an answer the client streams has stream timings.
   */
  readonly streamAsked: Option.Option<boolean>;
  readonly servedBy: Option.Option<string>;
  readonly accountId: Option.Option<string>;
  /** via's own words for an error it answered itself; its code is `error`. */
  readonly errorMessage: Option.Option<string>;
  /** Why the upstream refused the request, when it did. */
  readonly upstreamError: Option.Option<UpstreamError>;
  readonly error: Option.Option<string>;
  readonly usage: Option.Option<TokenUsage>;
  readonly retryAfter: Option.Option<string>;
  readonly status: number;
  readonly headersAt: number;
  readonly streamed: boolean;
  readonly firstChunkAt: Option.Option<number>;
  readonly streamEnd: Option.Option<string>;
  readonly logged: boolean;
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
 * A request that asked for a model is also kept in the `UsageHistory`; one it
 * can't keep is only warned about, as the answer has already gone out.
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
    const history = yield* UsageHistory;
    const id = yield* requestId(request.headers);
    const start = yield* Clock.currentTimeMillis;

    const noting = yield* Ref.make<Noted>({
      key: Option.none(),
      model: Option.none(),
      streamAsked: Option.none(),
      servedBy: Option.none(),
      accountId: Option.none(),
      errorMessage: Option.none(),
      upstreamError: Option.none(),
      error: Option.none(),
      usage: Option.none(),
      retryAfter: Option.none(),
      status: 0,
      headersAt: start,
      streamed: false,
      firstChunkAt: Option.none(),
      streamEnd: Option.none(),
      logged: true,
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
          ...noted(
            "key",
            Option.map(line.key, (key) => key.name),
          ),
          ...noted("model", line.model),
          ...noted("served_by", line.servedBy),
          ...noted("error", line.error),
          ...noted(
            "upstream_error",
            Option.flatMap(line.upstreamError, (upstream) => upstream.code),
          ),
          ...noted("retry_after", line.retryAfter),
          ...usageAnnotations(line.usage),
          ...(streamedAnswer(line)
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

    // Kept before the line is logged, so whoever sees the line finds the request kept.
    const keep = (line: Noted) =>
      Option.match(line.model, {
        onNone: () => Effect.void,
        onSome: (model) =>
          Effect.flatMap(Clock.currentTimeMillis, (end) =>
            history.record(entryOf(id, start, end, model, line)),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not keep the request in the usage history", cause),
            ),
          ),
      });

    const finish = Ref.modify(noting, (sofar): [Noted, Noted] => {
      const line = { ...sofar, pending: sofar.pending - 1 };

      return [line, line];
    }).pipe(
      // A host's health checks would drown out the requests.
      Effect.flatMap((line) =>
        line.pending === 0 && line.logged && request.url !== "/healthz"
          ? Effect.andThen(keep(line), log(line))
          : Effect.void,
      ),
    );

    const service = RequestLog.of({
      key: (key) => note({ key: Option.some(key) }),
      asked: (model, stream) =>
        note({ model: Option.some(model), streamAsked: Option.some(stream) }),
      served: (by, accountId) =>
        note({ servedBy: Option.some(by), accountId: Option.fromUndefinedOr(accountId) }),
      refused: (code, message) =>
        note({ error: Option.some(code), errorMessage: Option.some(message) }),
      upstreamFailed: (error) => note({ upstreamError: Option.some(error) }),
      usage: (usage) => note({ usage: Option.some(usage) }),
      unlogged: note({ logged: false }),
      timed: (stream) =>
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
      // The server answers a defect with a bare 500 and, with its own logger off, says no more.
      Effect.tapCause((cause) =>
        Cause.hasDies(cause)
          ? Effect.logError("Request failed unexpectedly", Cause.pretty(cause))
          : Effect.void,
      ),
      Effect.annotateLogs({ request_id: id }),
      Effect.ensuring(finish),
    );
  });
