import { AccountTokens, type RefreshRejectedError } from "@via/codex-auth";
import { CodexUpstream, collectResponse } from "@via/codex-upstream";
import { KeyStore } from "@via/keys";
import { classify, PoolStates, retryAfter, Verdict } from "@via/pool";
import { type ProviderPath, Providers, type Route } from "@via/providers";
import { Clock, Effect, Option, type Schema } from "effect";
import {
  type HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { accountsAllowed, nextAccount } from "./accounts.ts";
import { ModelCatalog } from "./catalog.ts";
import { RequestLog } from "./request-log.ts";

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
    response: Record<string, unknown>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, Schema.SchemaError>,
) =>
  collectResponse(upstream.stream).pipe(
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
 * Sends a request for a provider's model to that provider and pipes its answer
 * back as it comes, errors included.
 */
export const forward = Effect.fn("forward")(function* (
  route: Route,
  path: ProviderPath,
  body: Record<string, unknown>,
  session: string,
) {
  const log = yield* RequestLog;
  yield* log.asked(`${route.provider}/${route.model}`);
  yield* log.served(route.provider);
  return yield* (yield* Providers).send(route, path, body, session).pipe(
    Effect.flatMap((upstream) =>
      Effect.map(log.timed(upstream.stream), (stream) =>
        HttpServerResponse.stream(stream, {
          status: upstream.status,
          contentType: upstream.headers["content-type"] ?? "application/json",
        }),
      ),
    ),
    Effect.catchTag("HttpClientError", () =>
      openAiError(502, "upstream_unavailable", `${route.provider} could not be reached`),
    ),
  );
});

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
  body: Record<string, unknown>,
  session: string,
  onSuccess: (
    upstream: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const tokens = yield* AccountTokens;
  const codex = yield* CodexUpstream;
  const states = yield* PoolStates;
  const log = yield* RequestLog;
  if (typeof body.model === "string") yield* log.asked(body.model);
  const allowed =
    typeof body.model === "string" ? yield* (yield* ModelCatalog).mayServe(body.model) : () => true;
  // A dead refresh token takes the account out of rotation until it logs in again.
  const lockOut = (id: string) => (error: RefreshRejectedError) => states.lockOut(id, error.code);

  // Accounts whose access token was already refreshed after a 401 in this request.
  const refreshed = new Set<string>();

  while (true) {
    const next = yield* nextAccount(allowed);
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
      return yield* onSuccess(upstream);
    }

    const text = yield* upstream.text;
    const verdict = classify(upstream.status, upstream.headers, text, now);
    if (Verdict.$is("Cooldown")(verdict)) {
      yield* Effect.logWarning(
        `${account.label} is cooling down until ${new Date(verdict.until).toISOString()} (${verdict.reason})`,
      );
      yield* states.mark(account.id, {
        status: "cooling",
        until: verdict.until,
        reason: verdict.reason,
      });
      continue;
    }
    if (Verdict.$is("Unauthorized")(verdict)) {
      if (refreshed.has(account.id)) {
        yield* Effect.logWarning(
          `${account.label} is out of use: Codex rejects its token even after a refresh`,
        );
        yield* states.mark(account.id, {
          status: "auth_error",
          reason: "unauthorized",
        });
      } else {
        refreshed.add(account.id);
        yield* tokens
          .refreshRejected(account.id, account.accessToken)
          .pipe(Effect.catchTag("RefreshRejectedError", lockOut(account.id)));
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
