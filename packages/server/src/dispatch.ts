import { AccountTokens } from "@via/codex-auth";
import { CodexUpstream, collectResponse } from "@via/codex-upstream";
import { KeyStore } from "@via/keys";
import { classify, PoolStates, retryAfter, Verdict } from "@via/pool";
import { type ProviderPath, Providers, type Route } from "@via/providers";
import { Clock, Effect, identity, Option, Schema, type Stream } from "effect";
import {
  type HttpClientError,
  type HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  accountsAllowed,
  coolDown,
  lockOut,
  nextAccount,
  setAsideOnFailedRefresh,
} from "./accounts.ts";
import { ModelCatalog } from "./catalog.ts";
import { RequestLog } from "./request-log.ts";
import { SessionBindings } from "./session-bindings.ts";
import { spotUsage, usageOf } from "./token-usage.ts";

/** An error in the shape OpenAI clients expect, noted in the request's log line. */
export const openAiError = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    yield* (yield* RequestLog).refused(code);

    return HttpServerResponse.jsonUnsafe(
      {
        error: {
          message,
          type: status >= 500 ? "server_error" : "invalid_request_error",
          code,
        },
      },
      { status, headers },
    );
  });

const unreadable = openAiError(
  502,
  "upstream_incomplete",
  "The Codex stream broke off or could not be read",
);

/**
 * Reads a Codex stream to its final response for a non-streaming client, and
 * answers a response that failed or broke off with a 502.
 */
export const collected = (
  upstream: HttpClientResponse.HttpClientResponse,
  onResponse: (
    response: Schema.JsonObject,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Schema.SchemaError>,
) =>
  collectResponse(upstream.stream).pipe(
    Effect.tap((response) =>
      Effect.flatMap(RequestLog, (log) =>
        Option.match(usageOf(response["usage"]), {
          onNone: () => Effect.void,
          onSome: log.usage,
        }),
      ),
    ),
    Effect.flatMap(onResponse),
    Effect.catchTags({
      UpstreamFailedError: (error) => openAiError(502, error.code, error.reason),
      IncompleteStreamError: (error) => openAiError(502, "upstream_incomplete", error.message),
      HttpClientError: () => unreadable,
      Retry: () => unreadable,
      SchemaError: () => unreadable,
      SseError: () => unreadable,
    }),
  );

/**
 * A response relaying `upstream`'s body through `relay` as it comes, with the
 * token usage it reports and the time of its first chunk noted in the
 * request's log line.
 */
export const relayed = <E>(
  upstream: HttpClientResponse.HttpClientResponse,
  options: { readonly status?: number; readonly contentType: string },
  relay: (
    body: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
  ) => Stream.Stream<Uint8Array, E>,
) =>
  Effect.gen(function* () {
    const log = yield* RequestLog;
    const sse = (upstream.headers["content-type"] ?? "").includes("text/event-stream");
    const body = yield* log.timed(relay(spotUsage(upstream.stream, sse, log.usage)));

    return HttpServerResponse.stream(body, options);
  });

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

const namesModel = Schema.is(Schema.Struct({ model: Schema.String }));

/** The model a request body asks for, if it names one. */
export const modelOf = (body: Schema.JsonObject) =>
  namesModel(body) ? Option.some(body.model) : Option.none();

/** The client's API key, if it presented a valid one. */
const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const [scheme, key] = (request.headers.authorization ?? "").split(" ");

  if (scheme !== "Bearer" || key === undefined) return Option.none();

  return yield* (yield* KeyStore).verify(key);
});

/** Runs `handler` only for a client with a valid API key; anyone else gets a 401. */
export const authenticated = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if (Option.isNone(yield* authenticate)) {
      return yield* openAiError(401, "invalid_api_key", "Missing or unknown API key");
    }

    return yield* handler;
  });

const noAccountLeft = (waitMs: Option.Option<number>) =>
  Option.match(waitMs, {
    onNone: () => openAiError(503, "no_accounts", "No enabled account can serve requests"),
    onSome: (ms) =>
      openAiError(429, "rate_limit_exceeded", "Every account is cooling down", {
        "retry-after": String(Math.ceil(ms / 1000)),
      }),
  });

/**
 * Sends a Responses request to Codex through the pool, fill-first: accounts are
 * tried in order, skipping those cooling down or locked out, until one answers.
 * Only accounts whose plan offers the model are tried, when via knows which do.
 * A successful answer goes to `onSuccess`; a client error is returned as-is.
 */
export const dispatch = Effect.fn("dispatch")(function* <E, R>(
  body: Schema.JsonObject,
  session: string,
  onSuccess: (
    upstream: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const tokens = yield* AccountTokens;
  const codex = yield* CodexUpstream;
  const states = yield* PoolStates;
  const log = yield* RequestLog;
  const bindings = yield* SessionBindings;

  const model = modelOf(body);

  if (Option.isSome(model)) yield* log.asked(model.value);

  const allowed = Option.isSome(model)
    ? yield* (yield* ModelCatalog).mayServe(model.value)
    : () => true;

  // Accounts whose access token was already refreshed after a 401 in this request.
  const refreshed = new Set<string>();
  // The account that answered this session last time, if via still remembers it:
  // preferred over fill-first, so the conversation stays on a warm prompt cache.
  const preferred = yield* bindings.get(session);

  while (true) {
    const next = yield* nextAccount(allowed, preferred);
    const now = yield* Clock.currentTimeMillis;

    if (Option.isNone(next)) {
      return yield* noAccountLeft(
        retryAfter(yield* accountsAllowed(allowed), yield* states.get, now),
      );
    }

    const account = next.value;

    const sent = yield* codex.send(account, body, session).pipe(
      Effect.asSome,
      // Codex is unreachable for every account alike, so there is no one to fail over to.
      Effect.catchTag("HttpClientError", () => Effect.succeedNone),
    );

    if (Option.isNone(sent)) {
      return yield* openAiError(502, "upstream_unavailable", "Codex could not be reached");
    }

    const upstream = sent.value;

    if (upstream.status === 200) {
      yield* log.served(account.label);
      yield* bindings.bind(session, account.id);

      return yield* onSuccess(upstream);
    }

    // An error body that breaks off still leaves its status to judge the answer by.
    const text = yield* upstream.text.pipe(Effect.orElseSucceed(() => ""));
    const verdict = classify(upstream.status, upstream.headers, text, now);

    if (Verdict.$is("Cooldown")(verdict)) {
      yield* coolDown(account, verdict.until, verdict.reason);
      continue;
    }

    if (Verdict.$is("Unauthorized")(verdict)) {
      if (refreshed.has(account.id)) {
        // Codex rejects its token even after a refresh.
        yield* lockOut(account, "unauthorized");
      } else {
        refreshed.add(account.id);
        yield* tokens
          .refreshRejected(account.id, account.accessToken)
          .pipe(setAsideOnFailedRefresh(account));
      }

      continue;
    }

    yield* log.served(account.label);

    return HttpServerResponse.text(text, {
      status: upstream.status,
      contentType: upstream.headers["content-type"] ?? "application/json",
    });
  }
});
