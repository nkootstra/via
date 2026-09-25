import {
  ChatRequest,
  CompletedResponse,
  toChatCompletion,
  toChatStream,
  toResponsesRequest,
} from "@via/translate";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  authenticate,
  collected,
  dispatch,
  openAiError,
  unauthenticated,
} from "./dispatch.ts";

/** POST /v1/chat/completions: Chat Completions, translated to and from Responses. */
export const chatCompletions = Effect.gen(function* () {
  if (Option.isNone(yield* authenticate)) return unauthenticated();
  const decoded = yield* HttpServerRequest.schemaBodyJson(ChatRequest).pipe(
    Effect.option,
  );
  if (Option.isNone(decoded)) {
    return openAiError(
      400,
      "invalid_request",
      "The request is not a valid chat completion",
    );
  }
  const chat = decoded.value;
  return yield* dispatch(toResponsesRequest(chat), (upstream) =>
    chat.stream === true
      ? Effect.succeed(
          HttpServerResponse.stream(
            toChatStream(upstream.stream, {
              includeUsage: chat.stream_options?.include_usage === true,
            }),
            { contentType: "text/event-stream" },
          ),
        )
      : collected(upstream, (response) =>
          Schema.decodeUnknownEffect(CompletedResponse)(response).pipe(
            Effect.map((completed) =>
              HttpServerResponse.jsonUnsafe(toChatCompletion(completed)),
            ),
          ),
        ),
  );
});
