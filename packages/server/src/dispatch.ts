import { AccountStore, AccountTokens, type RefreshRejectedError } from "@via/codex-auth";
import { CodexUpstream, collectResponse } from "@via/codex-upstream";
import { KeyStore } from "@via/keys";
import { classify, PoolStates, retryAfter, select, Verdict } from "@via/pool";
import { Clock, Effect, Option, type Schema } from "effect";
import {
  type HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** An error in the shape OpenAI clients expect. */
export const openAiError = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code,
      },
    },
    { status, headers },
  );

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
      UpstreamFailedError: (error) => Effect.succeed(openAiError(502, error.code, error.reason)),
      IncompleteStreamError: (error) =>
        Effect.succeed(openAiError(502, "upstream_incomplete", error.message)),
      HttpClientError: () => Effect.succeed(unreadable),
      Retry: () => Effect.succeed(unreadable),
      SchemaError: () => Effect.succeed(unreadable),
      SseError: () => Effect.succeed(unreadable),
    }),
  );

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
      return openAiError(401, "invalid_api_key", "Missing or unknown API key");
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
 * A successful answer goes to `onSuccess`; a client error is returned as-is.
 */
export const dispatch = Effect.fn("dispatch")(function* <E, R>(
  body: Record<string, unknown>,
  onSuccess: (
    upstream: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const store = yield* AccountStore;
  const tokens = yield* AccountTokens;
  const codex = yield* CodexUpstream;
  const states = yield* PoolStates;
  // A dead refresh token takes the account out of rotation until it logs in again.
  const lockOut = (id: string) => (error: RefreshRejectedError) => states.lockOut(id, error.code);

  // Accounts whose access token was already refreshed after a 401 in this request.
  const refreshed = new Set<string>();

  while (true) {
    const accounts = yield* store.list;
    const state = yield* states.get;
    const now = yield* Clock.currentTimeMillis;
    const chosen = select(accounts, state, now);
    if (Option.isNone(chosen)) return noAccountLeft(retryAfter(accounts, state, now));

    const fresh = yield* tokens.fresh(chosen.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        RefreshRejectedError: (error) =>
          lockOut(chosen.value.id)(error).pipe(Effect.as(Option.none())),
        // The issuer itself is having trouble; cool the account down rather than fail
        // the whole request, the same way an upstream hiccup already does below.
        AuthRequestError: () =>
          states
            .mark(chosen.value.id, {
              status: "cooling",
              until: now + 60_000,
              reason: "auth_unavailable",
            })
            .pipe(Effect.as(Option.none())),
      }),
    );
    if (Option.isNone(fresh)) continue;
    const account = fresh.value;
    const sent = yield* codex.send(account, body).pipe(
      Effect.asSome,
      // Codex is unreachable for every account alike, so there is no one to fail over to.
      Effect.catchTag("HttpClientError", () => Effect.succeedNone),
    );
    if (Option.isNone(sent)) {
      return openAiError(502, "upstream_unavailable", "Codex could not be reached");
    }
    const upstream = sent.value;
    if (upstream.status === 200) return yield* onSuccess(upstream);

    const text = yield* upstream.text;
    const verdict = classify(upstream.status, upstream.headers, text, now);
    if (Verdict.$is("Cooldown")(verdict)) {
      yield* states.mark(account.id, {
        status: "cooling",
        until: verdict.until,
        reason: verdict.reason,
      });
      continue;
    }
    if (Verdict.$is("Unauthorized")(verdict)) {
      if (refreshed.has(account.id)) {
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
    return HttpServerResponse.text(text, {
      status: upstream.status,
      contentType: upstream.headers["content-type"] ?? "application/json",
    });
  }
});
