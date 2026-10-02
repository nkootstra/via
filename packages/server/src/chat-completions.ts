import { ChatRequest, toResponsesRequest } from "@via/translate";
import { Providers } from "@via/providers";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { authenticated } from "./authenticated.ts";
import { dispatch, modelOf } from "./dispatch.ts";
import { forward } from "./forward.ts";
import { openAiError } from "./openai-error.ts";
import { chatFromResponses } from "./chat-answer.ts";
import { resolveSession } from "./session.ts";
import { withSharedPrefix } from "./shared-prefix.ts";

const decodeChat = Schema.decodeUnknownEffect(ChatRequest);

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

    const responses = toResponsesRequest(chat.value);
    // Codex sends reasoning summaries, the chat answer's reasoning content, only when asked.
    const reasoning = { ...responses.reasoning, summary: "auto" };

    return yield* dispatch({ ...responses, reasoning }, session, (upstream, failed) =>
      chatFromResponses(upstream, chat.value, failed),
    );
  }),
);
