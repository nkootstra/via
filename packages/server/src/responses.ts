import { AccountStore, AccountTokens } from "@via/codex-auth";
import { collectResponse, CodexUpstream } from "@via/codex-upstream";
import { KeyStore } from "@via/keys";
import { select } from "@via/pool";
import { Clock, Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

/** An error in the shape OpenAI clients expect. */
export const openAiError = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, type: "invalid_request_error", code } },
    { status },
  );

/** The client's API key, if it presented a valid one. */
export const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const [scheme, key] = (request.headers.authorization ?? "").split(" ");
  if (scheme !== "Bearer" || key === undefined) return Option.none();
  return yield* (yield* KeyStore).verify(key);
});

export const responses = Effect.gen(function* () {
  if (Option.isNone(yield* authenticate)) {
    return openAiError(401, "invalid_api_key", "Missing or unknown API key");
  }
  const body = yield* HttpServerRequest.schemaBodyJson(RequestBody);
  const accounts = yield* (yield* AccountStore).list;
  const now = yield* Clock.currentTimeMillis;
  const chosen = select(accounts, {}, now);
  if (Option.isNone(chosen)) {
    return openAiError(503, "no_accounts", "No usable account");
  }
  const account = yield* (yield* AccountTokens).fresh(chosen.value.id);
  const upstream = yield* (yield* CodexUpstream).send(account, body);
  if (body.stream === true) {
    return HttpServerResponse.stream(upstream.stream, { contentType: "text/event-stream" });
  }
  return HttpServerResponse.jsonUnsafe(yield* collectResponse(upstream.stream));
});
