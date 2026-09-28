import { OpencodeGoPool, type ProviderPath, Providers, type Route } from "@via/providers";
import { Effect, identity, Option, type Schema } from "effect";
import type { HttpClientResponse } from "effect/unstable/http";
import { noAccountLeft } from "./dispatch.ts";
import { openAiError } from "./openai-error.ts";
import { relayed } from "./relay.ts";
import { RequestLog } from "./request-log.ts";
import { SessionBindings } from "./session-bindings.ts";

/** The provider's answer piped back as it comes, errors included. */
const relay = (upstream: HttpClientResponse.HttpClientResponse) =>
  relayed(
    upstream,
    {
      status: upstream.status,
      contentType: upstream.headers["content-type"] ?? "application/json",
    },
    identity,
  );

const unreachable = (route: Route) =>
  openAiError(502, "upstream_unavailable", `${route.provider} could not be reached`);

/**
 * Sends a request for OpenCode Go's model through its accounts: to the account
 * that answered the session last while it can serve, else fill-first, skipping
 * those cooling down or locked out. An account answered 429 cools down and one
 * whose key is refused is locked out, and the next one is tried.
 */
const forwardPooled = Effect.fn("forwardPooled")(function* (
  route: Route,
  path: ProviderPath,
  body: Schema.JsonObject,
  session: string,
) {
  const log = yield* RequestLog;
  const providers = yield* Providers;
  const pool = yield* OpencodeGoPool;
  const bindings = yield* SessionBindings;
  // Apart from Codex's bindings, so a session using both keeps a warm cache on each.
  const binding = `${route.provider}:${session}`;
  const preferred = yield* bindings.get(binding);

  while (true) {
    const next = yield* pool.next(preferred);

    if (Option.isNone(next)) {
      return yield* noAccountLeft(yield* pool.waitFor, "OpenCode Go account");
    }

    const account = next.value;

    const sent = yield* providers.send(route, path, body, session, account.apiKey).pipe(
      Effect.asSome,
      // OpenCode Go is unreachable for every account alike, so there is no one to fail over to.
      Effect.catchTag("HttpClientError", () => Effect.succeedNone),
    );

    if (Option.isNone(sent)) return yield* unreachable(route);
    const upstream = sent.value;

    if (upstream.status === 429) {
      yield* pool.rateLimited(account, upstream.headers["retry-after"]);
      continue;
    }

    if (upstream.status === 401) {
      yield* pool.lockOut(account, "unauthorized");
      continue;
    }

    yield* log.served(account.label, account.id);
    yield* bindings.bind(binding, account.id);

    return yield* relay(upstream);
  }
});

/**
 * Sends a request for a provider's model to that provider and pipes its answer
 * back as it comes, errors included. OpenCode Go's go through its accounts.
 */
export const forward = Effect.fn("forward")(function* (
  route: Route,
  path: ProviderPath,
  body: Schema.JsonObject,
  session: string,
) {
  const log = yield* RequestLog;
  yield* log.asked(`${route.provider}/${route.model}`);

  if (route.pooled) return yield* forwardPooled(route, path, body, session);
  yield* log.served(route.provider);

  return yield* (yield* Providers).send(route, path, body, session).pipe(
    Effect.flatMap(relay),
    Effect.catchTag("HttpClientError", () => unreachable(route)),
  );
});
