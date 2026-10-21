import {
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  Option,
  Ref,
  References,
  Schema,
  Stream,
} from "effect";
import { CapturedRequests, CaptureSettingsStore, UsageHistory } from "@via/usage";
import {
  HttpEffect,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import type { CapturedRequest, RequestAttempt, UsageEntry } from "@via/usage";
import type { TokenUsage } from "./token-usage.ts";
import type { UpstreamError } from "../proxy/upstream-error.ts";
import { clientOf } from "../proxy/client.ts";
import type { Conversation } from "../proxy/session.ts";
import { type AttemptAnswer, captureOf, worthCapturing } from "./capture.ts";
import { categorize, keptMessage } from "./failure.ts";
import { LiveTurns } from "./live-turns.ts";
import type { LiveAttempt, LiveTurn } from "./turn-events.ts";

/**
 * Notes, for the one line via logs about each request, what the request is
 * for, and times the answer it streams.
 */
export class RequestLog extends Context.Service<
  RequestLog,
  {
    /** Records the API key the client presented. */
    readonly key: (key: ClientKey) => Effect.Effect<void>;
    /** Records the model the request asks for, and whether it asks for its answer as a stream. */
    readonly asked: (model: string, stream: boolean) => Effect.Effect<void>;
    /**
     * Records that `by`, a provider or an account's label, serves the request,
     * with the account's id when an account of a pool serves it.
     */
    readonly served: (by: string, accountId?: string) => Effect.Effect<void>;
    /** Records the error code of an answer via gives itself, such as `rate_limit_exceeded`. */
    readonly refused: (code: string, message: string) => Effect.Effect<void>;
    /**
     * Records that an upstream refused the request, with the code its answer gives. Its message,
     * which can quote the request, is left out.
     */
    readonly upstreamFailed: (error: UpstreamError) => Effect.Effect<void>;
    /**
     * Records that the model the client asked for, `requested`, couldn't serve, for `reason`,
     * and that another model now takes the request.
     */
    readonly fellBack: (requested: string, reason: string) => Effect.Effect<void>;
    /**
     * Sets aside what was noted about the model last asked, so the next one asked starts
     * afresh, and gives back what puts it back, should no other model serve.
     */
    readonly setAside: Effect.Effect<Effect.Effect<void>>;
    /**
     * Records that an upstream attempt starts now: the model last asked, sent to its
     * provider, by `account` when an account of a pool takes it.
     */
    readonly attempt: (account?: {
      readonly id: string;
      readonly label: string;
    }) => Effect.Effect<void>;
    /**
     * Records the status the upstream answered the current attempt with. An attempt left
     * open ends with the request: it served, or, with an error status, the upstream refused it.
     */
    readonly upstreamAnswered: (status: number) => Effect.Effect<void>;
    /**
     * Records that the current attempt ended now without serving, so via tries another
     * account, protocol or model, or gives up: with the status and error the upstream
     * answered, if it did, or with why it never answered or broke off.
     */
    readonly attemptFailed: (failure: AttemptFailure) => Effect.Effect<void>;
    /** Records the conversation the request belongs to. */
    readonly conversation: (conversation: Conversation) => Effect.Effect<void>;
    /**
     * Records the body the client sent to `endpoint`, to capture should the turn fail or
     * fall back while the setting to keep those is on. It is never logged.
     */
    readonly requestBody: (
      endpoint: CapturedRequest["endpoint"],
      body: Schema.JsonObject,
    ) => Effect.Effect<void>;
    /** Records the token usage the upstream reported for the answer. */
    readonly usage: (usage: TokenUsage) => Effect.Effect<void>;
    /** Leaves the request out of the log, as a file a page fetches with it. */
    readonly unlogged: Effect.Effect<void>;
    /**
     * `stream`, timed: the line waits for it to end and says when its first chunk came.
     * `around`, such as `keepAlive`, wraps `stream` once its first chunk is timed, so
     * what it adds doesn't count as the first chunk. It still fails as `around` does,
     * but without its error, which Bun would print.
     */
    readonly timed: <A, E, R, B, E2, R2>(
      stream: Stream.Stream<A, E, R>,
      around: (timed: Stream.Stream<A, E, R>) => Stream.Stream<B, E2, R2>,
    ) => Stream.Stream<B, undefined, R2>;
  }
>()("via/RequestLog") {}

/** `{ [key]: value }` for a value that was noted, else nothing. */
const noted = <A>(key: string, value: Option.Option<A>) =>
  Option.match(value, { onNone: () => ({}), onSome: (found) => ({ [key]: found }) });

/**
 * How a streamed answer ended: sent in full, stopped by the client going away
 * (which interrupts the stream), or broken off by an error, such as the
 * upstream dropping the connection.
 */
const streamEnd = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit)
    ? "completed"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "client_aborted"
      : "failed";

/**
 * An error code as the log and the usage history keep one: an identifier, such as
 * `rate_limit_exceeded`. An upstream's code can be any text, even a quote of the request.
 */
const Code = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,64}$/));

/** `code`, if it is an identifier. */
const asCode = Schema.decodeOption(Code);

/** A textual UUID (any version), the shape a client's `x-request-id` must have to be echoed. */
const RequestIdHeader = Schema.String.pipe(Schema.check(Schema.isUUID()));

/**
 * The client's own `x-request-id`, lower-cased, when it is a single valid UUID. A repeated
 * header arrives here already joined with ", " by `Headers`, which fails the UUID shape just
 * like any other malformed value. It is only echoed and logged: a client can send the same
 * one with many requests, so it never names a request in via.
 */
const clientRequestId = (headers: Record<string, string>) =>
  Option.map(Schema.decodeUnknownOption(RequestIdHeader)(headers["x-request-id"]), (sent) =>
    sent.toLowerCase(),
  );

/** The request's own id, a fresh UUIDv4, which names it in the history, its captures and logs. */
const requestId = Effect.flatMap(Crypto.Crypto, (crypto) =>
  // A true infra fault (the platform's entropy source failing); no per-request fallback applies.
  crypto.randomUUIDv4().pipe(Effect.orDie),
);

/** The usage annotations for a request's log line — absent when none was reported. */
const usageAnnotations = (usage: Option.Option<TokenUsage>) =>
  Option.match(usage, {
    onNone: () => ({}),
    onSome: (u) => ({
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      ...(u.cachedTokens === undefined ? {} : { cached_tokens: u.cachedTokens }),
      ...(u.cacheWriteTokens === undefined ? {} : { cache_write_tokens: u.cacheWriteTokens }),
      ...(u.reasoningTokens === undefined ? {} : { reasoning_tokens: u.reasoningTokens }),
      ...(u.costUsd === undefined ? {} : { cost_usd: u.costUsd }),
    }),
  });

/** The API key a client presented: its id, and its name as it is now. */
export interface ClientKey {
  readonly id: string;
  readonly name: string;
}

/**
 * Whether a request's answer went out as a stream the client asked for. A
 * request that asked for no model, such as the admin UI's event stream, counts
 * its streamed answer as one.
 */
const streamedAnswer = (line: Noted) =>
  line.streamed && Option.getOrElse(line.streamAsked, () => true);

/** The upstream a model goes to: the provider it is prefixed with, else Codex. */
const providerOf = (model: string) => {
  const slash = model.indexOf("/");

  return slash === -1 ? "codex" : model.slice(0, slash);
};

/** The usage-history entry for a request that asked for `model`, as `line` noted it. */
const entryOf = (
  id: string,
  start: number,
  end: number,
  model: string,
  client: Option.Option<string>,
  line: Noted,
): UsageEntry => {
  const usage = line.usage;

  const count = (read: (u: TokenUsage) => number | undefined) =>
    Option.flatMap(usage, (u) => Option.fromUndefinedOr(read(u)));

  return {
    requestId: id,
    at: start,
    status: line.status,
    error: Option.orElse(line.error, () =>
      Option.flatMap(line.upstreamError, (upstream) => upstream.code),
    ).pipe(Option.flatMap(asCode)),
    // Only via's own words: an upstream's message can quote the request it refused.
    errorMessage: line.errorMessage,
    streamEnd: streamedAnswer(line) ? line.streamEnd : Option.none(),
    keyId: Option.map(line.key, (key) => key.id),
    keyName: Option.map(line.key, (key) => key.name),
    model,
    provider: providerOf(model),
    accountId: line.accountId,
    accountLabel: Option.flatMap(line.accountId, () => line.servedBy),
    inputTokens: count((u) => u.inputTokens),
    cachedTokens: count((u) => u.cachedTokens),
    cacheWriteTokens: count((u) => u.cacheWriteTokens),
    outputTokens: count((u) => u.outputTokens),
    reasoningTokens: count((u) => u.reasoningTokens),
    costUsd: count((u) => u.costUsd),
    durationMs: end - start,
    firstChunkMs: streamedAnswer(line)
      ? Option.map(line.firstChunkAt, (at) => at - start)
      : Option.none(),
    requestedModel: line.requestedModel,
    fallbackReason: Option.flatMap(line.fallbackReason, asCode),
    conversationId: Option.map(line.conversation, (found) => found.conversationId),
    parentConversationId: Option.flatMap(line.conversation, (found) => found.parentConversationId),
    sessionSource: Option.map(line.conversation, (found) => found.source),
    agentType: Option.flatMap(line.conversation, (found) => found.agentType),
    client,
  };
};

/** What via knows of an attempt that didn't serve, as `RequestLog.attemptFailed` takes it. */
export interface AttemptFailure {
  readonly status?: number;
  readonly error?: UpstreamError;
  readonly cause?: "timeout" | "network";
}

/** An upstream attempt, as the request notes it. */
interface Attempted {
  readonly startedAt: number;
  readonly model: Option.Option<string>;
  readonly account: Option.Option<{ readonly id: string; readonly label: string }>;
  readonly status: Option.Option<number>;
  readonly error: Option.Option<UpstreamError>;
  readonly cause: Option.Option<"timeout" | "network">;
  /** When it failed; one still open ends with the request. */
  readonly failedAt: Option.Option<number>;
}

/**
 * How an attempt ended: one noted as failed did, as did one via tried another after. The
 * last one, still open, served, unless the upstream answered with an error status (it
 * refused the request, and the client got that), broke off with an error, or the request
 * still failed.
 */
const outcomeOf = (attempt: Attempted, last: boolean, line: Noted): RequestAttempt["outcome"] => {
  if (Option.isSome(attempt.failedAt) || !last) return "failed";

  if (Option.exists(attempt.status, (status) => status >= 400)) return "refused";

  return Option.isSome(attempt.error) || line.status >= 400 ? "failed" : "served";
};

/** The usage-history attempts of request `id`, ended at `end`, as `line` noted them. */
const attemptsOf = (id: string, end: number, line: Noted): ReadonlyArray<RequestAttempt> =>
  line.attempts.flatMap((attempt, seq): ReadonlyArray<RequestAttempt> => {
    if (Option.isNone(attempt.model)) return [];

    const next = line.attempts[seq + 1];
    const last = next === undefined;
    const outcome = outcomeOf(attempt, last, line);
    const failed = outcome !== "served";
    const endedAt = Option.getOrElse(attempt.failedAt, () => next?.startedAt ?? end);
    const error = failed ? attempt.error : Option.none();
    const code = Option.flatMap(error, (found) => Option.flatMap(found.code, asCode));
    const downstreamProvider = Option.flatMap(error, (found) => found.downstreamProvider);

    return [
      {
        requestId: id,
        seq,
        startedAt: attempt.startedAt,
        durationMs: endedAt - attempt.startedAt,
        // The answer's first chunk came from the attempt that answered, the last one.
        firstChunkMs:
          last && Option.isNone(attempt.failedAt) && streamedAnswer(line)
            ? Option.map(line.firstChunkAt, (at) => at - attempt.startedAt)
            : Option.none(),
        provider: providerOf(attempt.model.value),
        model: attempt.model.value,
        accountId: Option.map(attempt.account, (account) => account.id),
        accountLabel: Option.map(attempt.account, (account) => account.label),
        status: attempt.status,
        outcome,
        category: failed
          ? Option.some(
              categorize({
                status: attempt.status,
                code,
                downstreamProvider,
                cause: attempt.cause,
              }),
            )
          : Option.none(),
        upstreamCode: code,
        downstreamProvider,
        message: keptMessage(
          attempt.status,
          Option.flatMap(error, (found) => found.message),
        ),
      },
    ];
  });

/** What each of `attempts` that didn't serve answered, when the upstream answered at all. */
const answersOf = (
  attempts: ReadonlyArray<RequestAttempt>,
  line: Noted,
): ReadonlyArray<AttemptAnswer> =>
  attempts.flatMap((attempt) => {
    const body = Option.flatMap(Option.fromUndefinedOr(line.attempts[attempt.seq]), (tried) =>
      Option.flatMap(tried.error, (error) => Option.fromUndefinedOr(error.body)),
    );

    return attempt.outcome === "served" || Option.isNone(body)
      ? []
      : [{ seq: attempt.seq, status: attempt.status, body: body.value }];
  });

/**
 * How the latest attempt of request `id` stands, as `line` noted it, for the turns in
 * flight: still open, or ended as the usage history will keep it.
 */
const liveAttemptOf = (id: string, line: Noted): Option.Option<LiveAttempt> => {
  const seq = line.attempts.length - 1;
  const attempt = line.attempts[seq];

  if (attempt === undefined || Option.isNone(attempt.model)) return Option.none();

  if (Option.isSome(attempt.failedAt)) {
    const ended = attemptsOf(id, attempt.failedAt.value, line).find((kept) => kept.seq === seq);

    return Option.map(Option.fromUndefinedOr(ended), (kept) => ({ state: "ended", ...kept }));
  }

  return Option.some({
    state: "open",
    requestId: id,
    seq,
    startedAt: attempt.startedAt,
    provider: providerOf(attempt.model.value),
    model: attempt.model.value,
    accountId: Option.map(attempt.account, (account) => account.id),
    accountLabel: Option.map(attempt.account, (account) => account.label),
    status: attempt.status,
    firstChunkMs: streamedAnswer(line)
      ? Option.map(line.firstChunkAt, (at) => at - attempt.startedAt)
      : Option.none(),
  });
};

/** Request `id`, which came in at `start` from `client` and asks for `model`, as a turn in flight. */
const liveTurnOf = (
  id: string,
  start: number,
  model: string,
  client: Option.Option<string>,
  line: Noted,
): LiveTurn => ({
  requestId: id,
  at: start,
  model,
  conversationId: Option.map(line.conversation, (found) => found.conversationId),
  parentConversationId: Option.flatMap(line.conversation, (found) => found.parentConversationId),
  agentType: Option.flatMap(line.conversation, (found) => found.agentType),
  client,
  keyName: Option.map(line.key, (key) => key.name),
  attempts: [],
});

/** What a request's log line says, noted while the request is handled. */
interface Noted {
  readonly key: Option.Option<ClientKey>;
  readonly model: Option.Option<string>;
  /**
   * Whether the client asked for a stream. via relays a provider's answer as a
   * stream either way, but only an answer the client streams has stream timings.
   */
  readonly streamAsked: Option.Option<boolean>;
  readonly servedBy: Option.Option<string>;
  readonly accountId: Option.Option<string>;
  /** via's own words for an error it answered itself; its code is `error`. */
  readonly errorMessage: Option.Option<string>;
  /** That the upstream refused the request, when it did, with its code if it is an identifier. */
  readonly upstreamError: Option.Option<Pick<UpstreamError, "code">>;
  readonly error: Option.Option<string>;
  readonly usage: Option.Option<TokenUsage>;
  /** The model the client asked for, when it couldn't serve and another model took the request. */
  readonly requestedModel: Option.Option<string>;
  /** Why the model asked for couldn't serve. */
  readonly fallbackReason: Option.Option<string>;
  readonly conversation: Option.Option<Conversation>;
  /** The body the client sent, and where, for a capture. */
  readonly requestBody: Option.Option<{
    readonly endpoint: CapturedRequest["endpoint"];
    readonly body: Schema.JsonObject;
  }>;
  /** Every upstream attempt, in order, fallbacks included. */
  readonly attempts: ReadonlyArray<Attempted>;
  readonly retryAfter: Option.Option<string>;
  readonly status: number;
  readonly headersAt: number;
  readonly streamed: boolean;
  readonly firstChunkAt: Option.Option<number>;
  readonly streamEnd: Option.Option<string>;
  readonly logged: boolean;
  /** The line waits for both the response and, once it runs, its stream. */
  readonly pending: number;
}

/**
 * Whether `cause` holds a real defect: not one that is itself the answer, as
 * the platform dies with a 404 for no matching route or a 499 for a client that
 * gave up, which the request's own line already reports.
 */
const isUnexpected = <E>(cause: Cause.Cause<E>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      !HttpServerResponse.isHttpServerResponse(reason.defect) &&
      !HttpServerRespondable.isRespondable(reason.defect),
  );

/**
 * Runs `app` for one request and then logs it as Effect's own request log does
 * ("Sent HTTP response" in an `http.span`), adding the model, who served it,
 * and, for an error via answers itself, its code and any `Retry-After`. A
 * streamed answer is logged once the stream ends, so `http.span` covers it,
 * with when its headers and its first chunk were sent.
 *
 * A request that asked for a model is also kept in the `UsageHistory`; one it
 * can't keep is only warned about, as the answer has already gone out.
 *
 * It also gives every request its own id (see `requestId`), which annotates
 * every log made while handling it, so a cooldown warning ties back to its
 * request, and goes back as `x-request-id`, unless the client sent its own,
 * which goes back instead. Both the header and the
 * status are taken in a pre-response handler: that runs on the response
 * actually sent, including one the platform derives from a failure, such as
 * a 404 for no matching route or a 500 for a defect.
 */
export const logRequest = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const history = yield* UsageHistory;
    const captures = yield* CapturedRequests;
    const captureSettings = yield* CaptureSettingsStore;
    const live = yield* LiveTurns;
    const id = yield* requestId;
    const clientId = clientRequestId(request.headers);
    const start = yield* Clock.currentTimeMillis;
    const client = clientOf(request.headers);

    const noting = yield* Ref.make<Noted>({
      key: Option.none(),
      model: Option.none(),
      streamAsked: Option.none(),
      servedBy: Option.none(),
      accountId: Option.none(),
      errorMessage: Option.none(),
      upstreamError: Option.none(),
      error: Option.none(),
      usage: Option.none(),
      requestedModel: Option.none(),
      fallbackReason: Option.none(),
      conversation: Option.none(),
      requestBody: Option.none(),
      attempts: [],
      retryAfter: Option.none(),
      status: 0,
      headersAt: start,
      streamed: false,
      firstChunkAt: Option.none(),
      streamEnd: Option.none(),
      logged: true,
      pending: 1,
    });

    const note = (found: Partial<Noted>) => Ref.update(noting, (sofar) => ({ ...sofar, ...found }));

    const log = (line: Noted) =>
      Effect.log("Sent HTTP response").pipe(
        Effect.annotateLogs({
          request_id: id,
          ...noted("client_request_id", clientId),
          "http.method": request.method,
          "http.url": request.url,
          "http.status": line.status,
          ...noted(
            "key",
            Option.map(line.key, (key) => key.name),
          ),
          ...noted("model", line.model),
          ...noted("served_by", line.servedBy),
          ...noted("error", Option.flatMap(line.error, asCode)),
          ...noted(
            "upstream_error",
            Option.flatMap(line.upstreamError, (upstream) => upstream.code),
          ),
          ...noted("retry_after", line.retryAfter),
          ...noted("requested_model", line.requestedModel),
          ...noted("fallback_reason", Option.flatMap(line.fallbackReason, asCode)),
          ...usageAnnotations(line.usage),
          ...(streamedAnswer(line)
            ? {
                headers_ms: line.headersAt - start,
                ...noted(
                  "first_chunk_ms",
                  Option.map(line.firstChunkAt, (at) => at - start),
                ),
                ...noted("stream_end", line.streamEnd),
              }
            : {}),
        }),
        // As Effect's own request log does, but the span lasts until the answer is sent.
        Effect.provideService(References.CurrentLogSpans, [["http.span", start]]),
      );

    /**
     * Captures the body of a turn that failed or fell back, with what each upstream attempt
     * that failed answered, while the setting to keep them is on.
     */
    const capture = (entry: UsageEntry, attempts: ReadonlyArray<RequestAttempt>, line: Noted) =>
      Option.match(line.requestBody, {
        onNone: () => Effect.void,
        onSome: ({ endpoint, body }) =>
          Effect.gen(function* () {
            if (!worthCapturing(entry)) return;

            if (!(yield* captureSettings.get).keepFailedPrompts) return;
            const now = yield* Clock.currentTimeMillis;
            yield* captures.keep(captureOf(id, now, endpoint, body, answersOf(attempts, line)));
          }).pipe(
            // The answer has already gone out: a setting that can't be read, or a capture that
            // can't be kept, keeps nothing, and only says so.
            Effect.catchCause((cause) => Effect.logWarning("Could not capture the request", cause)),
          ),
      });

    /**
     * Ends a request that asked for a model: kept in the usage history when `kept`, then
     * no longer in flight, so whoever sees it end finds it kept.
     */
    const settle = (line: Noted, kept: boolean) =>
      Option.match(line.model, {
        onNone: () => Effect.void,
        onSome: (model) =>
          Effect.gen(function* () {
            const end = yield* Clock.currentTimeMillis;
            const entry = entryOf(id, start, end, model, client, line);
            const attempts = attemptsOf(id, end, line);

            if (kept) {
              // Captured first, so whoever sees the turn kept finds its capture.
              yield* capture(entry, attempts, line);
              yield* history
                .keep(entry, attempts)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not keep the request in the usage history", cause),
                  ),
                );
            }

            yield* live.end({ entry, attempts });
          }),
      });

    const finish = Ref.modify(noting, (sofar): [Noted, Noted] => {
      const line = { ...sofar, pending: sofar.pending - 1 };

      return [line, line];
    }).pipe(
      Effect.flatMap((line) => {
        if (line.pending !== 0) return Effect.void;

        // A host's health checks would drown out the requests.
        const logged = line.logged && request.url !== "/healthz";

        // Kept before the line is logged, so whoever sees the line finds the request kept.
        return Effect.andThen(settle(line, logged), logged ? log(line) : Effect.void);
      }),
    );

    /** Shows how the latest attempt stands now, while the request is in flight. */
    const showAttempt = Effect.flatMap(Ref.get(noting), (line) =>
      Option.match(liveAttemptOf(id, line), { onNone: () => Effect.void, onSome: live.attempt }),
    );

    /** Updates the current attempt, while it is open. */
    const noteAttempt = (update: (attempt: Attempted) => Attempted) =>
      Ref.update(noting, (sofar) => {
        const current = sofar.attempts.at(-1);

        if (current === undefined || Option.isSome(current.failedAt)) return sofar;

        return { ...sofar, attempts: [...sofar.attempts.slice(0, -1), update(current)] };
      });

    const service = RequestLog.of({
      key: (key) => note({ key: Option.some(key) }),
      // The first model asked starts the turn; its key and conversation are known by then.
      asked: (model, stream) =>
        Ref.modify(noting, (sofar): [Option.Option<Noted>, Noted] => {
          const line = { ...sofar, model: Option.some(model), streamAsked: Option.some(stream) };

          return [Option.isNone(sofar.model) ? Option.some(line) : Option.none(), line];
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (line) => live.start(liveTurnOf(id, start, model, client, line)),
            }),
          ),
        ),
      served: (by, accountId) =>
        note({ servedBy: Option.some(by), accountId: Option.fromUndefinedOr(accountId) }),
      refused: (code, message) =>
        note({ error: Option.some(code), errorMessage: Option.some(message) }),
      upstreamFailed: (error) =>
        Effect.andThen(
          note({ upstreamError: Option.some({ code: Option.flatMap(error.code, asCode) }) }),
          noteAttempt((attempt) => ({ ...attempt, error: Option.some(error) })),
        ),
      attempt: (account) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.update(noting, (sofar) => ({
            ...sofar,
            attempts: [
              ...sofar.attempts,
              {
                startedAt: now,
                model: sofar.model,
                account: Option.fromUndefinedOr(account),
                status: Option.none(),
                error: Option.none(),
                cause: Option.none(),
                failedAt: Option.none(),
              },
            ],
          })),
        ).pipe(Effect.andThen(showAttempt)),
      upstreamAnswered: (status) =>
        noteAttempt((attempt) => ({ ...attempt, status: Option.some(status) })).pipe(
          Effect.andThen(showAttempt),
        ),
      attemptFailed: (failure) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          noteAttempt((attempt) => ({
            ...attempt,
            status: Option.orElse(Option.fromUndefinedOr(failure.status), () => attempt.status),
            error: Option.orElse(Option.fromUndefinedOr(failure.error), () => attempt.error),
            cause: Option.fromUndefinedOr(failure.cause),
            failedAt: Option.some(now),
          })),
        ).pipe(Effect.andThen(showAttempt)),
      fellBack: (requested, reason) =>
        note({ requestedModel: Option.some(requested), fallbackReason: Option.some(reason) }),
      setAside: Ref.modify(noting, (sofar): [Effect.Effect<void>, Noted] => {
        const attempt = {
          model: sofar.model,
          streamAsked: sofar.streamAsked,
          servedBy: sofar.servedBy,
          accountId: sofar.accountId,
          error: sofar.error,
          errorMessage: sofar.errorMessage,
          upstreamError: sofar.upstreamError,
          usage: sofar.usage,
          requestedModel: sofar.requestedModel,
          fallbackReason: sofar.fallbackReason,
        };

        return [
          note(attempt),
          {
            ...sofar,
            servedBy: Option.none(),
            accountId: Option.none(),
            error: Option.none(),
            errorMessage: Option.none(),
            upstreamError: Option.none(),
            usage: Option.none(),
          },
        ];
      }),
      conversation: (conversation) => note({ conversation: Option.some(conversation) }),
      requestBody: (endpoint, body) => note({ requestBody: Option.some({ endpoint, body }) }),
      usage: (usage) => note({ usage: Option.some(usage) }),
      unlogged: note({ logged: false }),
      timed: (stream, around) =>
        // The line waits for the stream only once it runs: a response sent without its body,
        // such as a 204, never runs it. The server starts it as it sends the response, which
        // is before `app` ends, so the request cannot write the line while the stream runs.
        Stream.unwrap(
          Effect.as(
            Effect.acquireRelease(
              Ref.update(noting, (sofar) => ({
                ...sofar,
                streamed: true,
                pending: sofar.pending + 1,
              })),
              (_, exit) =>
                Effect.andThen(
                  Ref.update(noting, (line) => ({
                    ...line,
                    streamEnd: Option.some(
                      Option.isSome(line.upstreamError) ? "failed" : streamEnd(exit),
                    ),
                  })),
                  finish,
                ),
            ),
            around(
              // Only the first chunk is timed; `tap` would run an effect for every chunk.
              Stream.onFirst(stream, () =>
                Effect.flatMap(Clock.currentTimeMillis, (now) =>
                  note({ firstChunkAt: Option.some(now) }),
                ).pipe(Effect.andThen(showAttempt)),
              ),
            ),
          ),
        ).pipe(
          // Bun prints the error a response body fails with, stack and request included.
          // Failing with `undefined` still cuts the client off, so a truncated answer never
          // looks complete, but quietly: this line already says the stream failed.
          Stream.mapError(() => undefined),
        ),
    });

    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        note({
          status: response.status,
          retryAfter: Option.fromNullishOr(response.headers["retry-after"]),
          headersAt: now,
        }),
      ).pipe(
        Effect.as(
          HttpServerResponse.setHeader(
            response,
            "x-request-id",
            Option.getOrElse(clientId, () => id),
          ),
        ),
      ),
    );

    return yield* app.pipe(
      Effect.provideService(RequestLog, service),
      // The server answers a defect with a bare 500 and, with its own logger off, says no more.
      Effect.tapCause((cause) =>
        isUnexpected(cause)
          ? Effect.logError("Request failed unexpectedly", Cause.pretty(cause))
          : Effect.void,
      ),
      Effect.annotateLogs({ request_id: id }),
      Effect.ensuring(finish),
    );
  });
