// Test-only: a scriptable stand-in for chatgpt.com/backend-api. Replies (see
// ./replies.ts) are queued per test, so each test says exactly what Codex
// answers. The golden fixtures in ./fixtures come from openai/codex.
import { BunHttpServer } from "@effect/platform-bun";
import { Clock, Deferred, Effect, Layer, Schema, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { type CodexRequest, jsonText, type Plan, type Reply, reply } from "./replies.ts";
import { modelsPayload, usagePayload } from "./streams.ts";

const unscripted: Reply = (request) =>
  reply.error(599, {
    error: { message: `fake Codex: unscripted request to ${request.path}`, type: "unscripted" },
  })(request);

// Bun only resets the socket when a body fails after the sent frames were
// flushed; failing straight away ends the response cleanly and empty. The pause
// runs on the real clock so a test's TestClock can't freeze it. Bun logs any
// failure but an `undefined` one, so that is what the body fails with.
const hangUp = Stream.fromEffect(
  Effect.sleep("20 millis").pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())),
).pipe(Stream.drain, Stream.concat(Stream.fail(undefined)));

const endings = { close: Stream.empty, hangUp, stall: Stream.never };

const respond = (plan: Plan) =>
  Effect.gen(function* () {
    if (plan.gate !== undefined) yield* Deferred.await(plan.gate);

    const body = Stream.fromIterable(plan.chunks).pipe(
      Stream.concat(endings[plan.ending]),
      Stream.encodeText,
    );

    return HttpServerResponse.stream(body, {
      status: plan.status,
      headers: plan.headers,
      contentType: plan.contentType,
    });
  });

/** The request being served, as the fake records it, with `body` already read. */
const recorded = (body: Schema.JsonObject) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request): CodexRequest => {
    const url = new URL(request.url, "http://fake");

    return {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body,
    };
  });

/** What `map` holds for the account `request` was sent as. */
const ofAccount = <A>(map: ReadonlyMap<string, A>, request: CodexRequest) => {
  const account = request.headers["chatgpt-account-id"];

  return account === undefined ? undefined : map.get(account);
};

/** Requests in the order they arrived, and a way to wait for more. */
const requestLog = () => {
  const requests: Array<CodexRequest> = [];
  const arrived: ReadonlyArray<CodexRequest> = requests;
  let waiters: Array<{ count: number; deferred: Deferred.Deferred<void> }> = [];

  return {
    requests: arrived,
    add: (request: CodexRequest) =>
      Effect.gen(function* () {
        requests.push(request);

        const due = waiters.filter((waiter) => requests.length >= waiter.count);
        waiters = waiters.filter((waiter) => requests.length < waiter.count);

        yield* Effect.forEach(due, (waiter) => Deferred.succeed(waiter.deferred, undefined), {
          discard: true,
        });
      }),
    /** Waits until at least `count` requests have arrived. */
    received: (count: number) =>
      Effect.gen(function* () {
        if (requests.length >= count) return;
        const deferred = yield* Deferred.make<void>();
        waiters.push({ count, deferred });
        yield* Deferred.await(deferred);
      }),
  };
};

/**
 * Starts the fake for the current scope. Replies are served per request in
 * this order: the queue for the request's `chatgpt-account-id`, then the
 * shared queue, then the `respond` handler; a request none of them answers
 * fails with 599 so a missing script never passes silently.
 */
export const startFakeCodex = Effect.gen(function* () {
  const log = requestLog();
  const modelLog = requestLog();
  const shared: Array<Reply> = [];
  const perAccount = new Map<string, Array<Reply>>();
  const usageByAccount = new Map<string, { status: number; body: string }>();
  let catalog = JSON.stringify(modelsPayload);
  const catalogByAccount = new Map<string, string>();

  let handler: ((request: CodexRequest) => Reply) | undefined;

  const next = (request: CodexRequest): Reply =>
    ofAccount(perAccount, request)?.shift() ?? shared.shift() ?? handler?.(request) ?? unscripted;

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/codex/responses",
      HttpServerRequest.schemaBodyJson(Schema.JsonObject).pipe(
        Effect.flatMap(recorded),
        Effect.tap(log.add),
        Effect.flatMap((request) => respond(next(request)(request))),
        // Test fixture: a body that is not JSON is a bug in the code under test.
        Effect.orDie,
      ),
    ),
    HttpRouter.add(
      "GET",
      "/wham/usage",
      recorded({}).pipe(
        Effect.tap(log.add),
        Effect.map((request) => {
          const { status, body } = ofAccount(usageByAccount, request) ?? {
            status: 200,
            body: JSON.stringify(usagePayload),
          };

          return HttpServerResponse.text(body, { status, contentType: "application/json" });
        }),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/codex/models",
      recorded({}).pipe(
        Effect.tap(modelLog.add),
        Effect.map((request) =>
          HttpServerResponse.text(ofAccount(catalogByAccount, request) ?? catalog, {
            contentType: "application/json",
          }),
        ),
      ),
    ),
  );

  const server = yield* Layer.build(
    HttpRouter.serve(routes).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 }))),
  );

  const url = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server));

  return {
    /** Where via should send Codex traffic (`VIA_CODEX_BASE_URL`). */
    url,
    /** Every request received so far, in order, except those for `/codex/models`. */
    requests: log.requests,
    /** Every `/codex/models` request received so far, in order. */
    modelRequests: modelLog.requests,
    /** Queues replies for any account, served in order. */
    script: (...replies: ReadonlyArray<Reply>) => void shared.push(...replies),
    /** Queues replies for one ChatGPT account, served before the shared queue. */
    forAccount: (account: string, ...replies: ReadonlyArray<Reply>) =>
      void perAccount.set(account, [...(perAccount.get(account) ?? []), ...replies]),
    /** Answers every request the queues don't. */
    respond: (answer: (request: CodexRequest) => Reply) => void (handler = answer),
    /**
     * Sets one account's `/wham/usage` answer, a refusal when `status` is not
     * 200; until then, it reports `usagePayload`.
     */
    usage: (account: string, body: Schema.Json, status = 200) =>
      void usageByAccount.set(account, { status, body: jsonText(body) }),
    /**
     * Sets the `/codex/models` answer, for one account when `account` is given;
     * until then, it lists the models via bundles.
     */
    models: (body: Schema.Json, account?: string) => {
      if (account === undefined) catalog = jsonText(body);
      else catalogByAccount.set(account, jsonText(body));
    },
    /** Waits until at least `count` requests have arrived. */
    received: log.received,
    /** Waits until at least `count` `/codex/models` requests have arrived. */
    modelsReceived: modelLog.received,
  };
});

/** A running fake Codex, as `startFakeCodex` gives it. */
export type FakeCodex = Effect.Success<typeof startFakeCodex>;
