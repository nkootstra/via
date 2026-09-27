import { collectResponse, streamIncomplete } from "@via/codex-upstream";
import { Effect, Option, type Schema, type Stream } from "effect";
import {
  type HttpClientError,
  type HttpClientResponse,
  HttpServerResponse,
} from "effect/unstable/http";
import { openAiError } from "./openai-error.ts";
import { RequestLog } from "./request-log.ts";
import { spotUsage, usageOf } from "./token-usage.ts";

const unreadable = openAiError(
  502,
  streamIncomplete.code,
  "The Codex stream broke off or could not be read",
);

/**
 * Reads a Codex stream to its final response for a non-streaming client, and
 * answers a response that failed or broke off with a 502.
 */
export const collected = (
  upstream: HttpClientResponse.HttpClientResponse,
  onResponse: (
    response: Schema.JsonObject,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Schema.SchemaError>,
) =>
  collectResponse(upstream.stream).pipe(
    Effect.tap((response) =>
      Effect.flatMap(RequestLog, (log) =>
        Option.match(usageOf(response["usage"]), {
          onNone: () => Effect.void,
          onSome: log.usage,
        }),
      ),
    ),
    Effect.flatMap(onResponse),
    Effect.catchTags({
      UpstreamFailedError: (error) => openAiError(502, error.code, error.reason),
      IncompleteStreamError: (error) => openAiError(502, streamIncomplete.code, error.message),
    }),
    // The body broke off, was not SSE, or held an event that is not a Responses one.
    Effect.catch(() => unreadable),
  );

/**
 * A response relaying `upstream`'s body through `relay` as it comes, with the
 * token usage it reports and the time of its first chunk noted in the
 * request's log line.
 */
export const relayed = <E>(
  upstream: HttpClientResponse.HttpClientResponse,
  options: { readonly status?: number; readonly contentType: string },
  relay: (
    body: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
  ) => Stream.Stream<Uint8Array, E>,
) =>
  Effect.gen(function* () {
    const log = yield* RequestLog;
    const sse = (upstream.headers["content-type"] ?? "").includes("text/event-stream");
    const body = yield* log.timed(relay(spotUsage(upstream.stream, sse, log.usage)));

    return HttpServerResponse.stream(body, options);
  });
