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
   * What the rest of `body` waits for once its first character is sent, with the
   * headers. It doesn't wait by default.
   */
  held?: Effect.Effect<void>;
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
  /**
   * A JSON body that starts at once with a newline, which JSON allows, and goes
   * on only once `held` completes: a provider that starts its answer before the
   * model is done, as OpenRouter does.
   */
  jsonHeld:
    (held: Effect.Effect<void>, body: Schema.Json): ProviderReply =>
    () => ({
      status: 200,
      contentType: "application/json",
      body: `\n${JSON.stringify(body)}`,
      held,
    }),
};

const Body = Schema.JsonObject;

/**
 * Starts the fake for the current scope. It answers `POST /chat/completions`
 * and `POST /responses` with the `respond` handler (599 until one is set),
 * `GET /models` with the models given to `models`, and `GET /usage` with `usage`,
 * at its root and under `/v1`; with `ollama`, it answers `GET /api/version` too.
 */
/** `body` as JSON, or a string as it is. */
const textOf = (body: Schema.Json) => (Predicate.isString(body) ? body : JSON.stringify(body));

export const startFakeProvider = Effect.gen(function* () {
  const requests: Array<ProviderRequest> = [];
  let handler = unscripted;
  let modelList: ReadonlyArray<Schema.JsonObject> | undefined;
  let ollamaVersion: string | undefined;
  const keyInfo = new Map<string, Schema.JsonObject | string>();
  const modelRequests: Array<ProviderRequest> = [];
  let usageAnswer = { status: 500, body: "" };
  let usageHeld: Effect.Effect<void> = Effect.void;
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
      const { status, contentType, body, headers = {}, held, ending } = handler(request);

      if (held === undefined && ending === undefined) {
        return HttpServerResponse.text(body, { status, contentType, headers });
      }

      const sent =
        held === undefined
          ? Stream.make(body)
          : Stream.make(body.slice(0, 1)).pipe(
              Stream.concat(Stream.drain(Stream.fromEffect(held))),
              Stream.concat(Stream.make(body.slice(1))),
            );

      const rest =
        ending === undefined
          ? Stream.empty
          : ending === "hang"
            ? Stream.never
            : // Failing with `undefined` drops the connection without Bun printing the error.
              Stream.fromEffect(Effect.andThen(ending.drop, Effect.fail(undefined)));

      return HttpServerResponse.stream(sent.pipe(Stream.concat(rest), Stream.encodeText), {
        status,
        contentType,
      });
    }),
    // Test fixture: a body that is not JSON is a bug in the code under test.
    Effect.orDie,
  );

  // Ollama serves the OpenAI-compatible routes under `/v1`, next to its own `/api`.
  const routesAt = (prefix: "" | "/v1") =>
    [
      HttpRouter.add("POST", `${prefix}/chat/completions`, answer),
      HttpRouter.add("POST", `${prefix}/responses`, answer),
      HttpRouter.add("POST", `${prefix}/messages`, answer),
      HttpRouter.add("POST", `${prefix}/systemone`, answer),
      HttpRouter.add(
        "GET",
        `${prefix}/models`,
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
        `${prefix}/usage`,
        Effect.gen(function* () {
          const request = yield* record(usageRequests, {});

          for (const waiter of usageWaiters) {
            if (usageRequests.length >= waiter.count) {
              yield* Deferred.succeed(waiter.deferred, undefined);
            }
          }

          yield* usageHeld;
          const { status, body } = usageByKey.get(keyOf(request) ?? "") ?? usageAnswer;

          return HttpServerResponse.text(body, { status, contentType: "application/json" });
        }),
      ),
    ] as const;

  const routes = Layer.mergeAll(
    Layer.mergeAll(...routesAt("")),
    Layer.mergeAll(...routesAt("/v1")),
    // OpenRouter's key info, for a key it knows; any other key it refuses.
    HttpRouter.add(
      "GET",
      "/key",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const known = keyInfo.get(request.headers["authorization"]?.replace(/^Bearer /, "") ?? "");

        if (known === undefined) {
          return HttpServerResponse.jsonUnsafe({ error: { code: 401 } }, { status: 401 });
        }

        return Predicate.isString(known)
          ? HttpServerResponse.text(known, { contentType: "application/json" })
          : HttpServerResponse.jsonUnsafe({ data: known });
      }),
    ),
    HttpRouter.add("GET", "/api/version", () =>
      Effect.succeed(
        ollamaVersion === undefined
          ? HttpServerResponse.text("", { status: 404 })
          : HttpServerResponse.jsonUnsafe({ version: ollamaVersion }),
      ),
    ),
  );

  const server = yield* Layer.build(
    HttpRouter.serve(routes).pipe(
      // No idle timeout: a held reply stays open, as a provider's does, instead of
      // Bun closing it after 10 quiet seconds.
      Layer.provideMerge(BunHttpServer.layer({ port: 0, idleTimeout: 0 })),
    ),
  );

  return {
    /** The provider's base URL, as config.yaml's `baseUrl`. */
    url: yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server)),
    /**
     * Answers `GET /key` sent with `apiKey` with `info`, as OpenRouter does, or with
     * a string as it is, such as a page that isn't JSON; any other key gets 401.
     */
    openrouterKey: (apiKey: string, info: Schema.JsonObject | string) =>
      void keyInfo.set(apiKey, info),
    /** Answers `GET /api/version` as Ollama `version` does; until then, it answers 404. */
    ollama: (version: string) => void (ollamaVersion = version),
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
    /**
     * Answers `GET /usage` with `body`, as OpenCode Go does, or with a string as it
     * is, such as a page that isn't JSON; until then, it answers 500.
     */
    usage: (body: Schema.Json, status = 200) => void (usageAnswer = { status, body: textOf(body) }),
    /** Answers `GET /usage` sent with `apiKey` with `body`, whatever `usage` says. */
    usageFor: (apiKey: string, body: Schema.Json, status = 200) =>
      void usageByKey.set(apiKey, { status, body: textOf(body) }),
    /** Answers `GET /usage` only once `held` completes, as a slow OpenCode Go does. */
    holdUsage: (held: Effect.Effect<void>) => void (usageHeld = held),
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
