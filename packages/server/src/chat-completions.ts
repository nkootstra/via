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
import { authenticated, collected, dispatch, forward, openAiError } from "./dispatch.ts";
import { resolveSession } from "./session.ts";

const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

/**
 * POST /v1/chat/completions: Chat Completions, translated to and from Responses
 * for Codex, or passed through to the provider its model names.
 */
export const chatCompletions = authenticated(
  Effect.gen(function* () {
    const providers = yield* Providers;
    const raw = yield* HttpServerRequest.schemaBodyJson(RequestBody).pipe(Effect.option);
    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    const route = Option.flatMap(raw, (body) => providers.route(body.model));
    if (Option.isSome(raw) && Option.isSome(route)) {
      const session = resolveSession(headers, raw.value);
      return yield* forward(route.value, "/chat/completions", raw.value, session);
    }
    const decoded = yield* Effect.fromOption(raw).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ChatRequest)),
      Effect.option,
    );
    if (Option.isNone(decoded)) {
      return openAiError(400, "invalid_request", "The request is not a valid chat completion");
    }
    const chat = decoded.value;
    return yield* dispatch(toResponsesRequest(chat), resolveSession(headers, chat), (upstream) =>
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
              Effect.map((completed) => HttpServerResponse.jsonUnsafe(toChatCompletion(completed))),
            ),
          ),
    );
  }),
);
