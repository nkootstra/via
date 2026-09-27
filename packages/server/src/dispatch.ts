import { AccountTokens } from "@via/codex-auth";
import { CodexUpstream } from "@via/codex-upstream";
import { classify, PoolStates, retryAfter, Verdict } from "@via/pool";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { type HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import {
  accountsAllowed,
  coolDown,
  lockOut,
  nextAccount,
  setAsideOnFailedRefresh,
} from "./accounts.ts";
import { ModelCatalog } from "./catalog.ts";
import { openAiError } from "./openai-error.ts";
import { RequestLog } from "./request-log.ts";
import { SessionBindings } from "./session-bindings.ts";

const namesModel = Schema.is(Schema.Struct({ model: Schema.String }));

/** The model a request body asks for, if it names one. */
export const modelOf = (body: Schema.JsonObject) =>
  namesModel(body) ? Option.some(body.model) : Option.none();

/** The answer once no account can serve: 429 while some cool down, else 503. */
const noAccountLeft = (waitMs: Option.Option<number>) =>
  Option.match(waitMs, {
    onNone: () => openAiError(503, "no_accounts", "No enabled account can serve requests"),
    onSome: (ms) =>
      openAiError(429, "rate_limit_exceeded", "Every account is cooling down", {
        "retry-after": String(Math.ceil(ms / 1000)),
      }),
  });

/**
 * Sends a Responses request to Codex through the pool: to the account that
 * answered the session last while it can serve, else fill-first, trying
 * accounts in order, skipping those cooling down or locked out, until one answers.
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
      Effect.result,
    );

    if (Result.isSuccess(sent)) {
      if (Option.isNone(sent.success)) {
        return yield* openAiError(502, "upstream_unavailable", "Codex could not be reached");
      }

      yield* log.served(account.label);
      yield* bindings.bind(session, account.id);

      return yield* onSuccess(sent.success.value);
    }

    const rejected = sent.failure;
    const verdict = classify(rejected.rejection, now);

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

    return HttpServerResponse.text(rejected.body, {
      status: rejected.status,
      contentType: rejected.contentType ?? "application/json",
    });
  }
});
