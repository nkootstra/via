import { OpencodeGoPool, type ProviderPath, Providers, type Route } from "@via/providers";
import { ChatRequest, toMessagesRequest, toResponsesRequest } from "@via/translate";
import { Effect, identity, Option, Schema } from "effect";
import { type HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { chatFromMessages, chatFromResponses } from "./chat-answer.ts";
import { ModelProtocols, type Protocol } from "./model-protocols.ts";
import { noAccountLeft, streams } from "./dispatch.ts";
import { openAiError } from "./openai-error.ts";
import { relayed } from "./relay.ts";
import { RequestLog } from "./request-log.ts";
import { SessionBindings } from "./session-bindings.ts";
import { upstreamErrorOf } from "./upstream-error.ts";

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

/** How a request goes out in one of OpenCode Go's protocols, and how its answer comes back. */
interface Attempt {
  readonly protocol: Protocol;
  readonly path: ProviderPath;
  readonly body: Schema.JsonObject;
  readonly answer: (
    upstream: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, RequestLog>;
}

const decodeChat = Schema.decodeUnknownOption(ChatRequest);

/**
 * The ways to send `body` to OpenCode Go, in the order to try them: as the
 * client sent it, then, for a Chat Completions request, translated into the
 * other protocols OpenCode Go serves, unless via already knows which one the
 * model speaks, which goes first. A request that isn't a valid chat request
 * goes only as it came.
 */
const attempts = (
  path: ProviderPath,
  body: Schema.JsonObject,
  known: Option.Option<Protocol>,
): ReadonlyArray<Attempt> => {
  const asSent: Attempt = { protocol: "chat", path, body, answer: relay };
  const chat = path === "/chat/completions" ? decodeChat(body) : Option.none();

  if (Option.isNone(chat)) return [asSent];

  const translated: Attempt = {
    protocol: "responses",
    path: "/responses",
    // Streamed either way: a client that isn't streaming gets the completion it ends in.
    body: { ...toResponsesRequest(chat.value), stream: true },
    answer: (upstream) => chatFromResponses(upstream, chat.value),
  };

  const messages: Attempt = {
    protocol: "messages",
    path: "/messages",
    body: toMessagesRequest(chat.value),
    answer: (upstream) => chatFromMessages(upstream, chat.value),
  };

  const all = [asSent, translated, messages];

  return Option.match(known, {
    onNone: () => all,
    onSome: (protocol) => [
      ...all.filter((attempt) => attempt.protocol === protocol),
      ...all.filter((attempt) => attempt.protocol !== protocol),
    ],
  });
};

/** OpenCode Go's error for a model asked in a protocol it doesn't speak. */
const PROTOCOL_UNSUPPORTED = "ModelProtocolUnsupported";

/**
 * Sends a request for OpenCode Go's model through its accounts: to the account
 * that answered the session last while it can serve, else fill-first, skipping
 * those cooling down or locked out. An account answered 429 cools down and one
 * whose key is refused is locked out, and the next one is tried. A model that
 * doesn't speak the request's protocol is asked again in the next one it may.
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
  const protocols = yield* ModelProtocols;
  // Apart from Codex's bindings, so a session using both keeps a warm cache on each.
  const binding = `${route.provider}:${session}`;
  const preferred = yield* bindings.get(binding);
  const tries = attempts(path, body, yield* protocols.get(route.model));

  while (true) {
    const next = yield* pool.next(preferred);

    if (Option.isNone(next)) {
      return yield* noAccountLeft(yield* pool.waitFor, "OpenCode Go account");
    }

    const account = next.value;

    // Every way to send it, on this account; a 429 or a refused key moves on to the next account.
    for (const [index, attempt] of tries.entries()) {
      const sent = yield* providers
        .send(route, attempt.path, attempt.body, session, account.apiKey)
        .pipe(
          Effect.asSome,
          // OpenCode Go is unreachable for every account alike, so there is no one to fail over to.
          Effect.catchTag("HttpClientError", () => Effect.succeedNone),
        );

      if (Option.isNone(sent)) return yield* unreachable(route);
      const upstream = sent.value;

      if (upstream.status === 429) {
        yield* pool.rateLimited(account, upstream.headers["retry-after"]);
        break;
      }

      if (upstream.status === 401) {
        yield* pool.lockOut(account, "unauthorized");
        break;
      }

      yield* log.served(account.label, account.id);
      yield* bindings.bind(binding, account.id);

      if (upstream.status < 400) {
        if (index > 0) yield* protocols.set(route.model, attempt.protocol);

        return yield* attempt.answer(upstream);
      }

      if (upstream.status !== 400) return yield* relay(upstream);

      // A 400 is read whole: it may only mean the model speaks another protocol.
      const text = yield* upstream.text.pipe(Effect.orElseSucceed(() => ""));
      const refusal = upstreamErrorOf(text);

      if (Option.contains(refusal.code, PROTOCOL_UNSUPPORTED) && index < tries.length - 1) continue;

      yield* log.upstreamFailed(refusal);

      return HttpServerResponse.text(text, {
        status: upstream.status,
        contentType: upstream.headers["content-type"] ?? "application/json",
      });
    }
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
  yield* log.asked(`${route.provider}/${route.model}`, streams(body));

  if (route.pooled) return yield* forwardPooled(route, path, body, session);
  yield* log.served(route.provider);

  return yield* (yield* Providers).send(route, path, body, session).pipe(
    Effect.flatMap(relay),
    Effect.catchTag("HttpClientError", () => unreachable(route)),
  );
});
