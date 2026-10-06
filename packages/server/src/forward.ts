import { streamIncomplete } from "@via/codex-upstream";
import { OpencodeGoPool, type ProviderPath, Providers, type Route } from "@via/providers";
import {
  ChatRequest,
  thinkSeparatedJson,
  thinkSeparatedStream,
  toMessagesRequest,
  toResponsesRequest,
} from "@via/translate";
import { Effect, identity, Option, Schema, Stream } from "effect";
import { Headers, type HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { chatFromMessages, chatFromResponses } from "./chat-answer.ts";
import { ModelProtocols, type Protocol } from "./model-protocols.ts";
import { noAccountLeft, streams } from "./dispatch.ts";
import { openAiError } from "./openai-error.ts";
import { answered, Outcome, unavailable } from "./outcome.ts";
import { failedResponse, relayed } from "./relay.ts";
import { RequestLog } from "./request-log.ts";
import { SessionBindings } from "./session-bindings.ts";
import { upstreamErrorOf } from "./upstream-error.ts";

/** The headers of a provider's answer a client may act on: when to try again, and its rate limits. */
const passedOn = (upstream: HttpClientResponse.HttpClientResponse) =>
  Headers.fromInput(
    Object.entries(upstream.headers).filter(
      ([key]) => key === "retry-after" || key.startsWith("x-ratelimit-"),
    ),
  );

const cutShort = "The provider's stream ended before its answer was complete";

/**
 * The event a provider's SSE answer to a request at each path ends in when it
 * breaks off, as that API reports an error mid-stream.
 */
const incomplete: Partial<Record<ProviderPath, string>> = {
  "/chat/completions": `data: ${JSON.stringify({
    error: { message: cutShort, type: "server_error", code: streamIncomplete.code },
  })}\n\n`,
  "/responses": `event: error\ndata: ${JSON.stringify({
    type: "error",
    code: streamIncomplete.code,
    message: cutShort,
    param: null,
  })}\n\n`,
};

/** A whole JSON body passed through `separate` once it has all come. */
const separatedWhole =
  <E>(separate: (body: string) => string) =>
  (body: Stream.Stream<Uint8Array, E>) =>
    Stream.unwrap(
      Effect.map(Stream.mkString(Stream.decodeText(body)), (text) =>
        Stream.make(new TextEncoder().encode(separate(text))),
      ),
    );

/**
 * How a provider's successful chat answer is relayed: with a leading
 * `<think>` block, which some models write their reasoning in, moved to
 * `reasoning_content`, streamed or whole.
 */
const chatRelay = (upstream: HttpClientResponse.HttpClientResponse) =>
  upstream.status >= 400
    ? identity
    : (upstream.headers["content-type"] ?? "").includes("text/event-stream")
      ? thinkSeparatedStream
      : separatedWhole(thinkSeparatedJson);

/**
 * The provider's answer to a request at `path`, piped back as it comes, errors
 * included, with its `passedOn` headers. A chat answer's reasoning is moved
 * out of its content (see `chatRelay`).
 */
const relay = (path: ProviderPath) => (upstream: HttpClientResponse.HttpClientResponse) =>
  relayed(
    upstream,
    {
      status: upstream.status,
      contentType: upstream.headers["content-type"] ?? "application/json",
      headers: passedOn(upstream),
      ...(incomplete[path] === undefined ? {} : { incomplete: incomplete[path] }),
    },
    path === "/chat/completions" ? chatRelay(upstream) : identity,
  );

const unreachable = (route: Route) =>
  unavailable(
    "upstream_unavailable",
    openAiError(502, "upstream_unavailable", `${route.provider} could not be reached`),
  );

/**
 * Whether a provider's error status says the model can't serve now, rather than that it
 * refused the request: rate limited, down, or not a model it has (404).
 */
const isOutage = (status: number) => status === 404 || status === 429 || status >= 500;

/** How much of a provider's error answer via reads: far more than an error says, far less than a page can. */
const ERROR_LIMIT = 64 * 1024;

/** `upstream`'s body as text, cut at {@link ERROR_LIMIT}; what broke off is what was read. */
const upToLimit = (upstream: HttpClientResponse.HttpClientResponse) =>
  upstream.stream.pipe(
    Stream.decodeText(),
    Stream.scan(
      () => "",
      (sofar: string, chunk: string) => sofar + chunk,
    ),
    Stream.takeUntil((sofar) => sofar.length >= ERROR_LIMIT),
    Stream.runLast,
    Effect.map((last) => Option.getOrElse(last, () => "").slice(0, ERROR_LIMIT)),
    // The status already says it failed; a body that breaks off only loses the detail.
    Effect.orElseSucceed(() => ""),
  );

/**
 * A provider's error answer, read whole and noted in the request's log line,
 * as the client gets it: with its status, content type and `passedOn` headers.
 */
const readWhole = (upstream: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const text = yield* upToLimit(upstream);
    const refusal = upstreamErrorOf(text);

    yield* (yield* RequestLog).upstreamFailed(refusal);

    return {
      refusal,
      response: HttpServerResponse.text(text, {
        status: upstream.status,
        contentType: upstream.headers["content-type"] ?? "application/json",
        headers: passedOn(upstream),
      }),
    };
  });

/**
 * The outcome of a provider's answer: an outage, read whole so it holds no
 * stream, leaves the model unavailable; anything else is relayed as it comes.
 */
const outcomeOf = (
  path: ProviderPath,
  upstream: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Outcome, never, RequestLog> =>
  isOutage(upstream.status)
    ? Effect.map(readWhole(upstream), ({ refusal, response }): Outcome =>
        Outcome.Unavailable({
          response,
          reason: Option.getOrElse(refusal.code, () => `http_${upstream.status}`),
        }),
      )
    : answered(relay(path)(upstream));

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
  const asSent: Attempt = { protocol: "chat", path, body, answer: relay(path) };
  const chat = path === "/chat/completions" ? decodeChat(body) : Option.none();

  if (Option.isNone(chat)) return [asSent];

  const translated: Attempt = {
    protocol: "responses",
    path: "/responses",
    // Streamed either way: a client that isn't streaming gets the completion it ends in.
    body: { ...toResponsesRequest(chat.value), stream: true },
    answer: (upstream) =>
      chatFromResponses(upstream, chat.value).pipe(
        Effect.catchTag("UpstreamFailedError", failedResponse),
      ),
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
 * whose key is refused or forbidden is locked out, and the next one is tried. A model that
 * doesn't speak the request's protocol is asked again in the next one it may.
 */
const forwardPooled = Effect.fn("forwardPooled")(function* (
  route: Route,
  path: ProviderPath,
  body: Schema.JsonObject,
  session: string,
  headers: Headers.Headers,
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
        .send(route, attempt.path, attempt.body, session, { apiKey: account.apiKey, headers })
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

      // A refused key and a forbidden account alike, as OpenCode Go's key check reads them.
      if (upstream.status === 401 || upstream.status === 403) {
        yield* pool.lockOut(account, "unauthorized");
        break;
      }

      yield* log.served(account.label, account.id);
      yield* bindings.bind(binding, account.id);

      if (upstream.status < 400) {
        if (index > 0) yield* protocols.set(route.model, attempt.protocol);

        return yield* answered(attempt.answer(upstream));
      }

      if (upstream.status !== 400) return yield* outcomeOf(attempt.path, upstream);

      // A 400 is read whole: it may only mean the model speaks another protocol. One whose
      // body breaks off reads as empty, so it is passed on as the plain 400 it is.
      const text = yield* upstream.text.pipe(Effect.orElseSucceed(() => ""));
      const refusal = upstreamErrorOf(text);
      const unsupported = Option.contains(refusal.code, PROTOCOL_UNSUPPORTED);

      if (unsupported && index < tries.length - 1) continue;

      yield* log.upstreamFailed(refusal);

      const response = HttpServerResponse.text(text, {
        status: upstream.status,
        contentType: upstream.headers["content-type"] ?? "application/json",
        headers: passedOn(upstream),
      });

      // Asked in every protocol it may speak, the model speaks none: it can't serve this.
      const outcome: Outcome = unsupported
        ? Outcome.Unavailable({ response, reason: PROTOCOL_UNSUPPORTED })
        : Outcome.Answered({ response });

      return outcome;
    }
  }
});

/**
 * Sends a request for a provider's model to that provider, with those of the
 * client's `headers` it may need, and pipes its answer back as it comes,
 * errors included. OpenCode Go's go through its accounts.
 *
 * Its outcome is `Unavailable` when the model can't serve now: not enabled,
 * no account left, out of reach, rate limited or down, or speaking none of the
 * protocols via could ask it in.
 */
export const forward = Effect.fn("forward")(function* (
  route: Route,
  path: ProviderPath,
  body: Schema.JsonObject,
  session: string,
  headers: Headers.Headers,
) {
  const log = yield* RequestLog;
  yield* log.asked(`${route.provider}/${route.model}`, streams(body));

  if (route.disabled === true) {
    return yield* unavailable(
      "model_not_found",
      openAiError(
        404,
        "model_not_found",
        `${route.provider}/${route.model} isn't enabled: enable it under OpenRouter on via's Accounts page`,
      ),
    );
  }

  if (route.pooled) return yield* forwardPooled(route, path, body, session, headers);
  yield* log.served(route.provider);

  return yield* (yield* Providers).send(route, path, body, session, { headers }).pipe(
    Effect.flatMap((upstream) => outcomeOf(path, upstream)),
    Effect.catchTag("HttpClientError", () => unreachable(route)),
  );
});
