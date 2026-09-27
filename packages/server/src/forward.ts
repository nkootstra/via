import { type ProviderPath, Providers, type Route } from "@via/providers";
import { Effect, identity, type Schema } from "effect";
import { openAiError } from "./openai-error.ts";
import { relayed } from "./relay.ts";
import { RequestLog } from "./request-log.ts";

/**
 * Sends a request for a provider's model to that provider and pipes its answer
 * back as it comes, errors included.
 */
export const forward = Effect.fn("forward")(function* (
  route: Route,
  path: ProviderPath,
  body: Schema.JsonObject,
  session: string,
) {
  const log = yield* RequestLog;
  yield* log.asked(`${route.provider}/${route.model}`);
  yield* log.served(route.provider);

  return yield* (yield* Providers).send(route, path, body, session).pipe(
    Effect.flatMap((upstream) =>
      relayed(
        upstream,
        {
          status: upstream.status,
          contentType: upstream.headers["content-type"] ?? "application/json",
        },
        identity,
      ),
    ),
    Effect.catchTag("HttpClientError", () =>
      openAiError(502, "upstream_unavailable", `${route.provider} could not be reached`),
    ),
  );
});
