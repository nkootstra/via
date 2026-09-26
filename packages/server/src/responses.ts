import { relayStream } from "@via/codex-upstream";
import { Providers } from "@via/providers";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { authenticated, collected, dispatch, forward, openAiError } from "./dispatch.ts";
import { RequestLog } from "./request-log.ts";
import { resolveSession } from "./session.ts";
import { spotUsage } from "./token-usage.ts";

const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

/** POST /v1/responses: the Responses API, passed through to Codex or the provider its model names. */
export const responses = authenticated(
  Effect.gen(function* () {
    const log = yield* RequestLog;
    const decoded = yield* HttpServerRequest.schemaBodyJson(RequestBody).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      return yield* openAiError(400, "invalid_request", "The request body is not a JSON object");
    }
    const body = decoded.value;
    const { headers } = yield* HttpServerRequest.HttpServerRequest;
    const session = resolveSession(headers, body);
    const route = (yield* Providers).route(body.model);
    if (Option.isSome(route)) return yield* forward(route.value, "/responses", body, session);
    return yield* dispatch(body, session, (upstream) =>
      body.stream === true
        ? Effect.map(
            log.timed(relayStream(spotUsage(upstream.stream, true, log.usage))),
            (stream) => HttpServerResponse.stream(stream, { contentType: "text/event-stream" }),
          )
        : collected(upstream, (response) =>
            Effect.succeed(HttpServerResponse.jsonUnsafe(response)),
          ),
    );
  }),
);
