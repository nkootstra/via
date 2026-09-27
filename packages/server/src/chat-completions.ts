import {
  ChatRequest,
  CompletedResponse,
  toChatCompletion,
  toChatStream,
  toResponsesRequest,
} from "@via/translate";
import { Providers } from "@via/providers";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  authenticated,
  collected,
  dispatch,
  forward,
  modelOf,
  openAiError,
  relayed,
} from "./dispatch.ts";
import { resolveSession } from "./session.ts";
import { withSharedPrefix } from "./shared-prefix.ts";

const decodeChat = Schema.decodeUnknownEffect(ChatRequest);

const decodeCompleted = Schema.decodeUnknownEffect(CompletedResponse);

const invalid = openAiError(400, "invalid_request", "The request is not a valid chat completion");

/**
 * POST /v1/chat/completions: Chat Completions, translated to and from Responses
 * for Codex, or passed through to the provider its model names.
 */
export const chatCompletions = authenticated(
  Effect.gen(function* () {
    const json = yield* HttpServerRequest.schemaBodyJson(Schema.JsonObject).pipe(Effect.option);

    if (Option.isNone(json)) return yield* invalid;

    const body = withSharedPrefix(json.value);
    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    const session = resolveSession(headers, body);
    const route = Option.flatMap(modelOf(body), (yield* Providers).route);

    if (Option.isSome(route))
      return yield* forward(route.value, "/chat/completions", body, session);

    const chat = yield* decodeChat(body).pipe(Effect.option);

    if (Option.isNone(chat)) return yield* invalid;

    const { stream, stream_options } = chat.value;

    return yield* dispatch(toResponsesRequest(chat.value), session, (upstream) =>
      stream === true
        ? relayed(upstream, { contentType: "text/event-stream" }, (events) =>
            toChatStream(events, { includeUsage: stream_options?.include_usage === true }),
          )
        : collected(upstream, (response) =>
            decodeCompleted(response).pipe(
              Effect.map((completed) => HttpServerResponse.jsonUnsafe(toChatCompletion(completed))),
            ),
          ),
    );
  }),
);
