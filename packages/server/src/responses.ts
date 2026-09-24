import { AccountStore, AccountTokens } from "@via/codex-auth";
import { collectResponse, CodexUpstream } from "@via/codex-upstream";
import { KeyStore } from "@via/keys";
import {
  type AccountState,
  classify,
  type PoolState,
  retryAfter,
  select,
  Verdict,
} from "@via/pool";
import { Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

const RequestBody = Schema.Record(Schema.String, Schema.Unknown);

/** Cooldowns and lockouts of the accounts, as learned from upstream answers. */
export class PoolStates extends Context.Service<PoolStates, Ref.Ref<PoolState>>()(
  "via/PoolStates",
) {
  static readonly layer = Layer.effect(PoolStates, Ref.make<PoolState>({}));
}

/** An error in the shape OpenAI clients expect. */
export const openAiError = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, type: "invalid_request_error", code } },
    { status, headers },
  );

/** The client's API key, if it presented a valid one. */
export const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const [scheme, key] = (request.headers.authorization ?? "").split(" ");
  if (scheme !== "Bearer" || key === undefined) return Option.none();
  return yield* (yield* KeyStore).verify(key);
});

const noAccountLeft = (waitMs: Option.Option<number>) =>
  Option.match(waitMs, {
    onNone: () => openAiError(503, "no_accounts", "No enabled account can serve requests"),
    onSome: (ms) =>
      openAiError(429, "rate_limit_exceeded", "Every account is cooling down", {
        "retry-after": String(Math.ceil(ms / 1000)),
      }),
  });

export const responses = Effect.gen(function* () {
  if (Option.isNone(yield* authenticate)) {
    return openAiError(401, "invalid_api_key", "Missing or unknown API key");
  }
  const body = yield* HttpServerRequest.schemaBodyJson(RequestBody);
  const store = yield* AccountStore;
  const tokens = yield* AccountTokens;
  const codex = yield* CodexUpstream;
  const states = yield* PoolStates;
  const mark = (id: string, state: AccountState) =>
    Ref.update(states, (current) => ({ ...current, [id]: state }));

  // Accounts whose access token was already refreshed after a 401 in this request.
  const refreshed = new Set<string>();

  // Fill-first: try accounts in order until one answers or none is left.
  while (true) {
    const accounts = yield* store.list;
    const state = yield* Ref.get(states);
    const now = yield* Clock.currentTimeMillis;
    const chosen = select(accounts, state, now);
    if (Option.isNone(chosen)) return noAccountLeft(retryAfter(accounts, state, now));

    const account = yield* tokens.fresh(chosen.value.id);
    const upstream = yield* codex.send(account, body);
    if (upstream.status === 200) {
      if (body.stream === true) {
        return HttpServerResponse.stream(upstream.stream, { contentType: "text/event-stream" });
      }
      return HttpServerResponse.jsonUnsafe(yield* collectResponse(upstream.stream));
    }

    const text = yield* upstream.text;
    const verdict = classify(upstream.status, upstream.headers, text, now);
    if (Verdict.$is("Cooldown")(verdict)) {
      yield* mark(account.id, { status: "cooling", until: verdict.until, reason: verdict.reason });
      continue;
    }
    if (Verdict.$is("Unauthorized")(verdict) && !refreshed.has(account.id)) {
      refreshed.add(account.id);
      yield* tokens.refreshRejected(account.id, account.accessToken);
      continue;
    }
    return HttpServerResponse.text(text, {
      status: upstream.status,
      contentType: upstream.headers["content-type"] ?? "application/json",
    });
  }
});
