import { KeyStore } from "@via/keys";
import { Effect, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { openAiError } from "./openai-error.ts";
import { RequestLog } from "../usage/request-log.ts";

/** The client's API key, if it presented a valid one. */
const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const [scheme, key] = (request.headers.authorization ?? "").split(" ");

  // An auth scheme is case-insensitive (RFC 9110 §11.1), so `bearer` counts too.
  if (scheme?.toLowerCase() !== "bearer" || key === undefined) return Option.none();

  return yield* (yield* KeyStore).verify(key);
});

/** Runs `handler` only for a client with a valid API key; anyone else gets a 401. */
export const authenticated = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const key = yield* authenticate;

    if (Option.isNone(key)) {
      return yield* openAiError(401, "invalid_api_key", "Missing or unknown API key");
    }

    yield* (yield* RequestLog).key(key.value);

    return yield* handler;
  });
