import {
  collectResponse,
  ResponseFailed,
  streamIncomplete,
  UpstreamFailedError,
} from "@via/codex-upstream";
import { Data, Duration, Effect, Option, Predicate, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import {
  Headers,
  type HttpClientError,
  type HttpClientResponse,
  HttpServerResponse,
} from "effect/unstable/http";
import { keepAlive } from "./keep-alive.ts";
import { openAiError } from "./openai-error.ts";
import { RequestLog } from "../usage/request-log.ts";
import { spotUsage, usageOf } from "../usage/token-usage.ts";
import { spotUpstreamError } from "./upstream-error.ts";

/**
 * How long an upstream may go quiet in the middle of an answer before via
 * gives up on it: as long as the Codex CLI waits (`stream_idle_timeout_ms`).
 * A reasoning model can think for minutes between chunks, so this is generous.
 */
const QUIET_LIMIT = Duration.minutes(5);

/** An upstream sent nothing for `QUIET_LIMIT` in the middle of an answer. */
export class UpstreamStalledError extends Data.TaggedError("UpstreamStalledError") {
  override get message() {
    return `The upstream sent nothing for ${Duration.format(QUIET_LIMIT)}`;
  }
}

/** `body`, failing once it has gone `QUIET_LIMIT` without a chunk, which ends the upstream request. */
const untilQuiet = <E>(body: Stream.Stream<Uint8Array, E>) =>
  Stream.timeoutOrElse(body, {
    duration: QUIET_LIMIT,
    orElse: () => Stream.fail(new UpstreamStalledError()),
  });

/**
 * A Codex stream that broke off before via could collect its answer, saying
 * what happened. Nothing has reached the client yet, so another model may serve.
 */
export class BrokenStreamError extends Data.TaggedError("BrokenStreamError")<{
  readonly message: string;
}> {}

/** The answer to a stream that broke off: a 502 saying what happened. */
export const brokenResponse = (error: BrokenStreamError) =>
  openAiError(502, streamIncomplete.code, error.message);

/**
 * Fails with what happened to Codex's answer, with the `cause` logged as a
 * warning: the client needs only what happened, the log why.
 */
const broken = (message: string, cause: string) =>
  Effect.andThen(
    Effect.logWarning(`${message}: ${cause}`),
    Effect.fail(new BrokenStreamError({ message })),
  );

/**
 * Reads a Codex stream to its final response for a non-streaming client, and
 * answers a response that grew too large or whose final response via can't
 * read with a 502, and one that took too long or went quiet too long with a 504.
 * A response Codex failed, or whose stream broke off, is left to the caller,
 * since nothing has reached the client yet: another account or model may serve it.
 */
export const collected = (
  upstream: HttpClientResponse.HttpClientResponse,
  onResponse: (
    response: Schema.JsonObject,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Schema.SchemaError>,
) =>
  collectResponse(untilQuiet(upstream.stream)).pipe(
    Effect.tap((response) =>
      Effect.flatMap(RequestLog, (log) =>
        Option.match(usageOf(response["usage"]), {
          onNone: () => Effect.void,
          onSome: log.usage,
        }),
      ),
    ),
    Effect.flatMap((response) =>
      onResponse(response).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.andThen(
            Effect.logWarning(`Codex's final response couldn't be read: ${error.message}`),
            openAiError(502, streamIncomplete.code, "Codex's final response couldn't be read"),
          ),
        ),
      ),
    ),
    Effect.catchTags({
      IncompleteStreamError: (error) =>
        Effect.fail(new BrokenStreamError({ message: error.message })),
      ResponseTooLargeError: (error) => openAiError(502, "upstream_too_large", error.message),
      ResponseTimeoutError: (error) => openAiError(504, "upstream_timeout", error.message),
      UpstreamStalledError: (error) => openAiError(504, "upstream_timeout", error.message),
      HttpClientError: (error) =>
        broken(
          "The connection to Codex broke off in the middle of its answer",
          // Its own message names only the request; what broke is in its cause.
          Predicate.isError(error.cause)
            ? `${error.message}: ${error.cause.message}`
            : error.message,
        ),
      SseError: (error) => broken("Codex sent an event via can't read", error.message),
      SchemaError: (error) => broken("Codex sent an event via can't read", error.message),
      Retry: (retry) =>
        broken(
          "Codex asked to be retried in the middle of its answer",
          `in ${Duration.format(retry.duration)}`,
        ),
    }),
  );

/** The answer to a response the upstream failed in its stream: a 502 with its code. */
export const failedResponse = (error: UpstreamFailedError) =>
  openAiError(502, error.code, error.reason);

const decodeFailed = Schema.decodeUnknownOption(Schema.fromJsonString(ResponseFailed));

/**
 * Taps a Responses SSE stream for a `response.failed` event, and calls `report`
 * with why Codex failed the response. The bytes pass through unchanged.
 */
const spotFailure = <E>(
  body: Stream.Stream<Uint8Array, E>,
  report: (error: UpstreamFailedError) => Effect.Effect<void>,
): Stream.Stream<Uint8Array, E> =>
  // Built fresh for each run of the stream, as `spotUsage` is.
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder();
      let found: Array<UpstreamFailedError> = [];

      const parser = Sse.makeParser((event) => {
        if (Sse.Retry.is(event)) return;

        for (const failed of Option.toArray(decodeFailed(event.data))) {
          const { code, message } = failed.response.error;
          found.push(new UpstreamFailedError({ code, reason: message }));
        }
      });

      return body.pipe(
        Stream.mapArrayEffect((chunks) => {
          for (const chunk of chunks) parser.feed(decoder.decode(chunk, { stream: true }));
          const spotted = found;
          found = [];

          return Effect.as(Effect.forEach(spotted, report, { discard: true }), chunks);
        }),
      );
    }),
  );

/**
 * Headers an SSE answer carries, so a proxy between via and the client, such
 * as nginx, passes each event on as it comes rather than holding it back.
 */
const UNBUFFERED = Headers.fromInput({ "cache-control": "no-cache", "x-accel-buffering": "no" });

/**
 * A response relaying `upstream`'s body through `relay` as it comes, with the
 * token usage it reports and the time of its first chunk noted in the
 * request's log line. An SSE body is kept alive through quiet spells.
 *
 * Whether the body is SSE is `sse` when given, else what its `content-type`
 * says. Codex always streams SSE but labels it with no `content-type` at all,
 * so its callers say so rather than read the header.
 */
export const relayed = <E>(
  upstream: HttpClientResponse.HttpClientResponse,
  options: {
    readonly status?: number;
    readonly contentType: string;
    /** Headers of `upstream`'s the answer keeps. */
    readonly headers?: Headers.Headers;
    readonly sse?: boolean;
    /**
     * The event an SSE body that breaks off, or goes quiet too long, ends in,
     * so the client knows the answer is cut short; without one, the body fails.
     */
    readonly incomplete?: string;
    /** False when `relay` reports the usage itself, from a body via can't read it in. */
    readonly spotUsage?: boolean;
    /** Told when the upstream fails the response in its SSE stream. */
    readonly onFailed?: (error: UpstreamFailedError) => Effect.Effect<void>;
  },
  relay: (
    body: Stream.Stream<Uint8Array, HttpClientError.HttpClientError | UpstreamStalledError>,
  ) => Stream.Stream<Uint8Array, E>,
) =>
  Effect.gen(function* () {
    const log = yield* RequestLog;

    const sse =
      options.sse ?? (upstream.headers["content-type"] ?? "").includes("text/event-stream");

    const body = untilQuiet(upstream.stream);

    const answer =
      sse && options.onFailed !== undefined ? spotFailure(body, options.onFailed) : body;

    // An error answer says why in its body; any other carries its usage.
    const relaying = relay(
      upstream.status >= 400
        ? spotUpstreamError(answer, log.upstreamFailed)
        : options.spotUsage === false
          ? answer
          : spotUsage(answer, sse, log.usage),
    );

    // Timed outermost: the request log counts the stream from when the server starts it.
    const passed = options.headers ?? Headers.empty;
    const timed = log.timed(sse ? keepAlive(relaying) : relaying);
    const { incomplete } = options;

    // Ended after the log has seen the stream fail, so its line still says it did. The blank
    // line ends whatever event the upstream broke off in, so the error is an event of its own.
    const ended =
      sse && incomplete !== undefined
        ? Stream.orElseSucceed(timed, () => new TextEncoder().encode(`\n\n${incomplete}`))
        : timed;

    return HttpServerResponse.stream(ended, {
      ...(options.status === undefined ? {} : { status: options.status }),
      headers: sse ? Headers.merge(passed, UNBUFFERED) : passed,
      contentType: options.contentType,
    });
  });
