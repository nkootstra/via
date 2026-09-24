import { collectResponse } from "@via/codex-upstream";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { authenticate, dispatch, unauthenticated } from "./dispatch.ts";

const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

/** POST /v1/responses: the Responses API, passed through to Codex. */
export const responses = Effect.gen(function* () {
  if (Option.isNone(yield* authenticate)) return unauthenticated();
  const body = yield* HttpServerRequest.schemaBodyJson(RequestBody);
  return yield* dispatch(body, (upstream) =>
    body.stream === true
      ? Effect.succeed(
          HttpServerResponse.stream(upstream.stream, { contentType: "text/event-stream" }),
        )
      : collectResponse(upstream.stream).pipe(Effect.map(HttpServerResponse.jsonUnsafe)),
  );
});
