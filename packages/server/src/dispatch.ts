import {
  CodexUpstream,
  isCodexAppOnly,
  resolveAlias,
  type UpstreamFailedError,
} from "@via/codex-upstream";
import { classify, Verdict } from "@via/pool";
import { Clock, type Data, Effect, Option, Result, Schema } from "effect";
import { type HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { AccountPool } from "@via/account-pool";
import { ModelCatalog } from "./catalog.ts";
import { openAiError } from "./openai-error.ts";
import { failedResponse } from "./relay.ts";
import { RequestLog } from "./request-log.ts";
import { SessionBindings } from "./session-bindings.ts";
import { upstreamErrorOf } from "./upstream-error.ts";

const namesModel = Schema.is(Schema.Struct({ model: Schema.String }));

/** The model a request body asks for, if it names one. */
export const modelOf = (body: Schema.JsonObject) =>
  namesModel(body) ? Option.some(body.model) : Option.none();

/** Whether a request body asks for its answer as a stream. */
export const streams = Schema.is(Schema.Struct({ stream: Schema.Literal(true) }));

/**
 * The answer once no `kind` of account can serve: 429 while some cool down,
 * else 503.
 */
export const noAccountLeft = (waitMs: Option.Option<number>, kind = "account") =>
  Option.match(waitMs, {
    onNone: () => openAiError(503, "no_accounts", `No enabled ${kind} can serve requests`),
    onSome: (ms) =>
      openAiError(429, "rate_limit_exceeded", `Every ${kind} is cooling down`, {
        "retry-after": String(Math.ceil(ms / 1000)),
      }),
  });

/**
 * The answer to a Codex outage: 503 when Codex is overloaded, else 502, with
 * its Retry-After. Every account would meet the same outage, so none is tried.
 */
const outage = (
  status: number,
  body: string,
  { reason, retryAfterMs }: Data.TaggedEnum.Value<Verdict, "Unavailable">,
) =>
  openAiError(
    status === 503 || reason === "server_is_overloaded" ? 503 : 502,
    reason,
    Option.getOrElse(
      upstreamErrorOf(body).message,
      () => `Codex failed the request (HTTP ${status})`,
    ),
    retryAfterMs === undefined ? {} : { "retry-after": String(Math.ceil(retryAfterMs / 1000)) },
  );

/** A request Codex refused, as it answered. */
type Refusal = {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
};

/** A refusal passed on as Codex sent it, to a client of Codex's own Responses API. */
const asSent = ({ status, contentType, body }: Refusal) =>
  HttpServerResponse.text(body, { status, contentType: contentType ?? "application/json" });

/**
 * A refusal in OpenAI's error shape, for a client of an API via translates:
 * with Codex's message and code when it gave them readably. An HTML page,
 * such as a proxy's, gives neither.
 */
export const asOpenAiError = ({ status, contentType, body }: Refusal) => {
  const { code, message } = (contentType ?? "").includes("html")
    ? { code: Option.none(), message: Option.none() }
    : upstreamErrorOf(body);

  return HttpServerResponse.jsonUnsafe(
    {
      error: {
        message: Option.getOrElse(message, () => `Codex refused the request (HTTP ${status})`),
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code: Option.getOrNull(code),
      },
    },
    { status },
  );
};

/**
 * Sends a Responses request to Codex through the pool: to the account that
 * answered the session last while it can serve, else fill-first, trying
 * accounts in order, skipping those cooling down or locked out, until one answers.
 * Only accounts whose plan offers the model are tried, when via knows which do.
 * An effort only the Codex app can run is refused before any account is tried.
 * A successful answer goes to `onSuccess`; a client error goes to `refused`,
 * which passes it on as it came unless told otherwise.
 * A response `onSuccess` finds Codex failed for a rate limit cools its account
 * down and goes to the next one, as a 429 would.
 */
export const dispatch = Effect.fn("dispatch")(function* <R>(
  body: Schema.JsonObject,
  session: string,
  onSuccess: (
    upstream: HttpClientResponse.HttpClientResponse,
    failed: (error: UpstreamFailedError) => Effect.Effect<void>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, UpstreamFailedError, R>,
  refused: (refusal: Refusal) => HttpServerResponse.HttpServerResponse = asSent,
) {
  const pool = yield* AccountPool;
  const codex = yield* CodexUpstream;
  const log = yield* RequestLog;
  const bindings = yield* SessionBindings;

  const model = modelOf(body);

  if (Option.isSome(model)) yield* log.asked(model.value, streams(body));

  const models = yield* ModelCatalog;
  const allowed = Option.isSome(model) ? yield* models.mayServe(model.value) : () => true;
  const catalog = yield* models.codex;

  if (Option.isSome(model)) {
    const alias = resolveAlias(model.value, catalog);

    if (isCodexAppOnly(alias.effort)) {
      return yield* openAiError(
        400,
        "unsupported_effort",
        `The ${alias.effort} effort only works in the Codex app, which delegates tasks to agents it runs; use ${alias.model}-max for the most reasoning via can give`,
      );
    }
  }

  // Accounts whose access token was already refreshed after a 401 in this request.
  const refreshed = new Set<string>();
  // The account that answered this session last time, if via still remembers it:
  // preferred over fill-first, so the conversation stays on a warm prompt cache.
  const preferred = yield* bindings.get(session);

  while (true) {
    const next = yield* pool.next(allowed, preferred);

    if (Option.isNone(next)) {
      return yield* noAccountLeft(yield* pool.waitFor(allowed));
    }

    const account = next.value;

    // Cools the account down when Codex failed its response for a rate limit; whether it did.
    const coolDownFor = (failed: UpstreamFailedError) =>
      Effect.gen(function* () {
        const verdict = classify(failed.rejection, yield* Clock.currentTimeMillis);

        if (!Verdict.$is("Cooldown")(verdict)) return false;

        yield* pool.coolDown(account, verdict.until, verdict.reason);

        return true;
      });

    const sent = yield* codex.send(account, body, session, catalog).pipe(
      Effect.asSome,
      // Codex is unreachable for every account alike, so there is no one to fail over to.
      Effect.catchTag("HttpClientError", () => Effect.succeedNone),
      Effect.result,
    );

    if (Result.isSuccess(sent)) {
      if (Option.isNone(sent.success)) {
        return yield* openAiError(502, "upstream_unavailable", "Codex could not be reached");
      }

      yield* log.served(account.label, account.id);

      const answered = yield* onSuccess(sent.success.value, (error) =>
        Effect.asVoid(coolDownFor(error)),
      ).pipe(Effect.result);

      if (Result.isSuccess(answered)) {
        yield* bindings.bind(session, account.id);

        return answered.success;
      }

      if (yield* coolDownFor(answered.failure)) continue;

      return yield* failedResponse(answered.failure);
    }

    const rejected = sent.failure;
    // Read after the send, which can take minutes: a cooldown runs from Codex's answer.
    const verdict = classify(rejected.rejection, yield* Clock.currentTimeMillis);

    if (Verdict.$is("Cooldown")(verdict)) {
      yield* pool.coolDown(account, verdict.until, verdict.reason);
      continue;
    }

    if (Verdict.$is("Unauthorized")(verdict)) {
      if (refreshed.has(account.id)) {
        // Codex rejects its token even after a refresh.
        yield* pool.lockOut(account, "unauthorized");
      } else {
        refreshed.add(account.id);
        yield* pool.refreshRejected(account);
      }

      continue;
    }

    yield* log.served(account.label, account.id);

    if (Verdict.$is("Unavailable")(verdict)) {
      return yield* outage(rejected.status, rejected.body, verdict);
    }

    yield* log.upstreamFailed(upstreamErrorOf(rejected.body));

    return refused(rejected);
  }
});
