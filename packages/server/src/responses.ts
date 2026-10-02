import { relayStream } from "@via/codex-upstream";
import { Providers } from "@via/providers";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { authenticated } from "./authenticated.ts";
import { dispatch, modelOf } from "./dispatch.ts";
import { forward } from "./forward.ts";
import { openAiError } from "./openai-error.ts";
import { collected, relayed } from "./relay.ts";
import { resolveSession } from "./session.ts";

/** POST /v1/responses: the Responses API, passed through to Codex or the provider its model names. */
export const responses = authenticated(
  Effect.gen(function* () {
    const decoded = yield* HttpServerRequest.schemaBodyJson(Schema.JsonObject).pipe(Effect.option);

    if (Option.isNone(decoded)) {
      return yield* openAiError(400, "invalid_request", "The request body is not a JSON object");
    }

    const body = decoded.value;
    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    const session = resolveSession(headers, body);
    const route = Option.flatMap(modelOf(body), (yield* Providers).route);

    if (Option.isSome(route)) return yield* forward(route.value, "/responses", body, session);

    return yield* dispatch(body, session, (upstream, failed) =>
      body.stream === true
        ? relayed(
            upstream,
            { contentType: "text/event-stream", sse: true, onFailed: failed },
            relayStream,
          )
        : collected(upstream, (response) =>
            Effect.succeed(HttpServerResponse.jsonUnsafe(response)),
          ),
    );
  }),
);
