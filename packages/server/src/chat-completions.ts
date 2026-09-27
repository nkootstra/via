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

/**
 * POST /v1/chat/completions: Chat Completions, translated to and from Responses
 * for Codex, or passed through to the provider its model names.
 */
export const chatCompletions = authenticated(
  Effect.gen(function* () {
    const providers = yield* Providers;

    const raw = Option.map(
      yield* HttpServerRequest.schemaBodyJson(Schema.JsonObject).pipe(Effect.option),
      withSharedPrefix,
    );

    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    const route = Option.flatMap(Option.flatMap(raw, modelOf), providers.route);

    if (Option.isSome(raw) && Option.isSome(route)) {
      const session = resolveSession(headers, raw.value);

      return yield* forward(route.value, "/chat/completions", raw.value, session);
    }

    const decoded = yield* Effect.fromOption(raw).pipe(
      Effect.flatMap((body) =>
        Effect.map(Schema.decodeUnknownEffect(ChatRequest)(body), (chat) => ({ body, chat })),
      ),
      Effect.option,
    );

    if (Option.isNone(decoded)) {
      return yield* openAiError(
        400,
        "invalid_request",
        "The request is not a valid chat completion",
      );
    }

    const { body, chat } = decoded.value;

    return yield* dispatch(toResponsesRequest(chat), resolveSession(headers, body), (upstream) =>
      chat.stream === true
        ? relayed(upstream, { contentType: "text/event-stream" }, (events) =>
            toChatStream(events, { includeUsage: chat.stream_options?.include_usage === true }),
          )
        : collected(upstream, (response) =>
            Schema.decodeUnknownEffect(CompletedResponse)(response).pipe(
              Effect.map((completed) => HttpServerResponse.jsonUnsafe(toChatCompletion(completed))),
            ),
          ),
    );
  }),
);
