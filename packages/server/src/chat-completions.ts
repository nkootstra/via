import { ChatRequest, toResponsesRequest } from "@via/translate";
import { Providers } from "@via/providers";
import { Effect, Option, Result, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { authenticated } from "./authenticated.ts";
import { asOpenAiError, dispatch, modelOf } from "./dispatch.ts";
import { withFallbacks } from "./fallback.ts";
import { forward } from "./forward.ts";
import { openAiError } from "./openai-error.ts";
import { answered } from "./outcome.ts";
import { chatFromResponses } from "./chat-answer.ts";
import { resolveSession } from "./session.ts";
import { withSharedPrefix } from "./shared-prefix.ts";

const decodeChat = Schema.decodeUnknownEffect(ChatRequest);

const notAnObject = openAiError(400, "invalid_request", "The request body is not a JSON object");

/** A chat request via can't read, refused with what is wrong with it, for the client to fix. */
const unreadable = (error: Schema.SchemaError) =>
  openAiError(
    400,
    "invalid_request",
    `The request isn't a chat completion via can read: ${error.message}`,
  );

/**
 * POST /v1/chat/completions: Chat Completions, translated to and from Responses
 * for Codex, or passed through to the provider its model names.
 */
export const chatCompletions = authenticated(
  Effect.gen(function* () {
    const json = yield* HttpServerRequest.schemaBodyJson(Schema.JsonObject).pipe(Effect.option);

    if (Option.isNone(json)) return yield* notAnObject;

    const body = withSharedPrefix(json.value);
    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    const session = resolveSession(headers, body);
    const providers = yield* Providers;

    /** Asks for the model `request` names: its provider as it is, or Codex, translated. */
    const attempt = (request: Schema.JsonObject) =>
      Effect.gen(function* () {
        const route = Option.flatMap(modelOf(request), providers.route);

        if (Option.isSome(route)) {
          return yield* forward(route.value, "/chat/completions", request, session, headers);
        }

        const chat = yield* decodeChat(request).pipe(Effect.result);

        if (Result.isFailure(chat)) return yield* answered(unreadable(chat.failure));

        const responses = toResponsesRequest(chat.success);
        // Codex sends reasoning summaries, the chat answer's reasoning content, only when asked.
        const reasoning = { ...responses.reasoning, summary: "auto" };

        return yield* dispatch(
          { ...responses, reasoning },
          session,
          (upstream, failed) => chatFromResponses(upstream, chat.success, failed),
          // A chat client speaks OpenAI's API, not Codex's: it reads OpenAI's errors.
          asOpenAiError,
        );
      });

    return yield* withFallbacks(body, attempt);
  }),
);
