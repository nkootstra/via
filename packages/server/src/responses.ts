import { relayStream } from "@via/codex-upstream";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { authenticated, collected, dispatch, openAiError } from "./dispatch.ts";

const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

/** POST /v1/responses: the Responses API, passed through to Codex. */
export const responses = authenticated(
  Effect.gen(function* () {
    const decoded = yield* HttpServerRequest.schemaBodyJson(RequestBody).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      return openAiError(400, "invalid_request", "The request body is not a JSON object");
    }
    const body = decoded.value;
    return yield* dispatch(body, (upstream) =>
      body.stream === true
        ? Effect.succeed(
            HttpServerResponse.stream(relayStream(upstream.stream), {
              contentType: "text/event-stream",
            }),
          )
        : collected(upstream, (response) =>
            Effect.succeed(HttpServerResponse.jsonUnsafe(response)),
          ),
    );
  }),
);
