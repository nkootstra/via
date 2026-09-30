import { Providers } from "@via/providers";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { authenticated } from "./authenticated.ts";
import { modelOf } from "./dispatch.ts";
import { forward } from "./forward.ts";
import { openAiError } from "./openai-error.ts";
import { resolveSession } from "./session.ts";

/**
 * POST /v1/systemone: Ollama's System One, which answers choice, yes/no and
 * scoring questions about a state with a local model, passed through to the
 * provider its model names, as in `ollama/nimble`. Codex has no such thing.
 */
export const systemOne = authenticated(
  Effect.gen(function* () {
    const decoded = yield* HttpServerRequest.schemaBodyJson(Schema.JsonObject).pipe(Effect.option);

    if (Option.isNone(decoded)) {
      return yield* openAiError(400, "invalid_request", "The request body is not a JSON object");
    }

    const body = decoded.value;
    const route = Option.flatMap(modelOf(body), (yield* Providers).route);

    if (Option.isNone(route)) {
      return yield* openAiError(
        400,
        "invalid_request",
        "System One goes to a provider that serves it, such as Ollama: ask for a model like ollama/nimble",
      );
    }

    const { headers } = yield* HttpServerRequest.HttpServerRequest;

    return yield* forward(route.value, "/systemone", body, resolveSession(headers, body));
  }),
);
