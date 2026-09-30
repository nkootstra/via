// Test-only: a scriptable OpenAI-compatible provider, such as OpenRouter or
// OpenCode Go, that records every request it receives.
import { BunHttpServer } from "@effect/platform-bun";
import { Deferred, Effect, Layer, Predicate, Schema, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

/** One request as via sent it. */
export type ProviderRequest = {
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Schema.JsonObject;
};

type Answer = {
  status: number;
  contentType: string;
  body: string;
  headers?: Readonly<Record<string, string>>;
  /**
   * What the stream does after `body`: stays open, or breaks off once `drop` completes.
   * It ends by default.
   */
  ending?: "hang" | { readonly drop: Effect.Effect<void> };
};

export type ProviderReply = (request: ProviderRequest) => Answer;

const unscripted: ProviderReply = () => ({
  status: 599,
  contentType: "application/json",
  body: JSON.stringify({ error: { message: "fake provider: unscripted" } }),
});

/** The API key a request was sent with, from its `authorization` header. */
const keyOf = (request: ProviderRequest) =>
  request.headers["authorization"]?.replace(/^Bearer /, "");

export const providerReply = {
  /** A JSON body, a chat completion or an error, with any extra `headers`. */
  json:
    (body: Schema.Json, status = 200, headers: Record<string, string> = {}): ProviderReply =>
    () => ({ status, contentType: "application/json", body: JSON.stringify(body), headers }),
  /** A 429 with an OpenAI error, as a key over its limits gets, and `headers` such as Retry-After. */
  rateLimited: (headers: Record<string, string> = {}): ProviderReply =>
    providerReply.json(
      { error: { message: "rate limited", type: "rate_limit_error" } },
      429,
      headers,
    ),
  /** Answers each request as `replies` says for the API key it was sent with, else as `otherwise`. */
  byKey:
    (replies: Readonly<Record<string, ProviderReply>>, otherwise = unscripted): ProviderReply =>
    (request) =>
      (replies[keyOf(request) ?? ""] ?? otherwise)(request),
  /** A raw SSE body. */
  sse:
    (body: string): ProviderReply =>
    () => ({ status: 200, contentType: "text/event-stream", body }),
  /** A raw SSE body that then never ends, so only the client can end it. */
  sseThenHang:
    (body: string): ProviderReply =>
    () => ({ status: 200, contentType: "text/event-stream", body, ending: "hang" }),
  /**
   * A raw SSE body, after which the connection breaks off once `drop` completes. Let
   * that wait for the client to see `body`: a time delay races with via relaying it.
   */
  sseThenDrop:
    (body: string, drop: Effect.Effect<void>): ProviderReply =>
    () => ({ status: 200, contentType: "text/event-stream", body, ending: { drop } }),
};

const Body = Schema.JsonObject;

/**
 * Starts the fake for the current scope. It answers `POST /chat/completions`
 * and `POST /responses` with the `respond` handler (599 until one is set),
 * `GET /models` with the models given to `models`, and `GET /usage` with `usage`.
 */
export const startFakeProvider = Effect.gen(function* () {
  const requests: Array<ProviderRequest> = [];
  let handler = unscripted;
  let modelList: ReadonlyArray<Schema.JsonObject> | undefined;
  const modelRequests: Array<ProviderRequest> = [];
  let usageAnswer = { status: 500, body: "" };
  const usageByKey = new Map<string, { status: number; body: string }>();
  const usageRequests: Array<ProviderRequest> = [];
  const waiters: Array<{ count: number; deferred: Deferred.Deferred<void> }> = [];
  const usageWaiters: Array<{ count: number; deferred: Deferred.Deferred<void> }> = [];

  const record = (list: Array<ProviderRequest>, body: Schema.JsonObject) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      const recorded = {
        path: new URL(request.url, "http://fake").pathname,
        headers: request.headers,
        body,
      };

      list.push(recorded);

      return recorded;
    });

  const answer = HttpServerRequest.schemaBodyJson(Body).pipe(
    Effect.flatMap((body) => record(requests, body)),
    Effect.map((request) => {
      const { status, contentType, body, headers = {}, ending } = handler(request);

      if (ending === undefined) {
        return HttpServerResponse.text(body, { status, contentType, headers });
      }

      const rest =
        ending === "hang"
          ? Stream.never
          : // Failing with `undefined` drops the connection without Bun printing the error.
            Stream.fromEffect(Effect.andThen(ending.drop, Effect.fail(undefined)));

      return HttpServerResponse.stream(
        Stream.make(body).pipe(Stream.concat(rest), Stream.encodeText),
        { status, contentType },
      );
    }),
    // Test fixture: a body that is not JSON is a bug in the code under test.
    Effect.orDie,
  );

  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/chat/completions", answer),
    HttpRouter.add("POST", "/responses", answer),
    HttpRouter.add("POST", "/messages", answer),
    HttpRouter.add(
      "GET",
      "/models",
      Effect.gen(function* () {
        yield* record(modelRequests, {});

        for (const waiter of waiters) {
          if (modelRequests.length >= waiter.count) {
            yield* Deferred.succeed(waiter.deferred, undefined);
          }
        }

        return modelList === undefined
          ? HttpServerResponse.text("", { status: 500 })
          : HttpServerResponse.jsonUnsafe({ object: "list", data: modelList });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/usage",
      Effect.gen(function* () {
        const request = yield* record(usageRequests, {});

        for (const waiter of usageWaiters) {
          if (usageRequests.length >= waiter.count) {
            yield* Deferred.succeed(waiter.deferred, undefined);
          }
        }

        const { status, body } = usageByKey.get(keyOf(request) ?? "") ?? usageAnswer;

        return HttpServerResponse.text(body, { status, contentType: "application/json" });
      }),
    ),
  );

  const server = yield* Layer.build(
    HttpRouter.serve(routes).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 }))),
  );

  return {
    /** The provider's base URL, as config.yaml's `baseUrl`. */
    url: yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server)),
    /** Every completion request received so far, in order. */
    get requests(): ReadonlyArray<ProviderRequest> {
      return requests;
    },
    /** Every `GET /models` request received so far, in order. */
    get modelRequests(): ReadonlyArray<ProviderRequest> {
      return modelRequests;
    },
    /** Every `GET /usage` request received so far, in order. */
    get usageRequests(): ReadonlyArray<ProviderRequest> {
      return usageRequests;
    },
    /** Answers `GET /usage` with `body`, as OpenCode Go does; until then, it answers 500. */
    usage: (body: Schema.Json, status = 200) =>
      void (usageAnswer = { status, body: JSON.stringify(body) }),
    /** Answers `GET /usage` sent with `apiKey` with `body`, whatever `usage` says. */
    usageFor: (apiKey: string, body: Schema.Json, status = 200) =>
      void usageByKey.set(apiKey, { status, body: JSON.stringify(body) }),
    /** Waits until at least `count` `GET /models` requests have arrived. */
    modelsReceived: (count: number) =>
      Effect.gen(function* () {
        if (modelRequests.length >= count) return;
        const deferred = yield* Deferred.make<void>();
        waiters.push({ count, deferred });
        yield* Deferred.await(deferred);
      }),
    /** Waits until at least `count` `GET /usage` requests have arrived. */
    usageReceived: (count: number) =>
      Effect.gen(function* () {
        if (usageRequests.length >= count) return;
        const deferred = yield* Deferred.make<void>();
        usageWaiters.push({ count, deferred });
        yield* Deferred.await(deferred);
      }),
    /** Answers every completion request. */
    respond: (reply: ProviderReply) => void (handler = reply),
    /**
     * Lists `models` at `GET /models`, each an id or a full model object; until
     * then, it answers 500.
     */
    models: (models: ReadonlyArray<string | Schema.JsonObject>) =>
      void (modelList = models.map((model) =>
        Predicate.isString(model) ? { id: model, object: "model" } : model,
      )),
  };
});

/** A running fake provider, as `startFakeProvider` gives it. */
export type FakeProvider = Effect.Success<typeof startFakeProvider>;
