// Test-only: a scriptable OpenAI-compatible provider, such as OpenRouter or
// OpenCode Go, that records every request it receives.
import { BunHttpServer } from "@effect/platform-bun";
import { Deferred, Effect, Layer, Schema, Stream } from "effect";
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
  body: Record<string, unknown>;
};

type Answer = {
  status: number;
  contentType: string;
  body: string;
  /**
   * What the stream does after `body`: stays open, or breaks off once `drop` completes.
   * It ends by default.
   */
  ending?: "hang" | { readonly drop: Effect.Effect<void> };
};

export type ProviderReply = (request: ProviderRequest) => Answer;

export const providerReply = {
  /** A JSON body, a chat completion or an error. */
  json:
    (body: unknown, status = 200): ProviderReply =>
    () => ({ status, contentType: "application/json", body: JSON.stringify(body) }),
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

const unscripted: ProviderReply = providerReply.json(
  { error: { message: "fake provider: unscripted" } },
  599,
);

const Body = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Starts the fake for the current scope. It answers `POST /chat/completions`
 * and `POST /responses` with the `respond` handler (500 until one is set) and
 * `GET /models` with the models given to `models`, and `GET /usage` with `usage`.
 */
export const startFakeProvider = Effect.gen(function* () {
  const requests: Array<ProviderRequest> = [];
  let handler = unscripted;
  let modelList: ReadonlyArray<Record<string, unknown>> | undefined;
  const modelRequests: Array<ProviderRequest> = [];
  let usageAnswer = { status: 500, body: "" };
  const usageRequests: Array<ProviderRequest> = [];
  const waiters: Array<{ count: number; deferred: Deferred.Deferred<void> }> = [];

  const answer = HttpServerRequest.schemaBodyJson(Body).pipe(
    Effect.flatMap((body) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        const recorded = {
          path: new URL(request.url, "http://fake").pathname,
          headers: request.headers,
          body,
        };

        requests.push(recorded);
        const { status, contentType, body: text, ending } = handler(recorded);

        if (ending === undefined) return HttpServerResponse.text(text, { status, contentType });

        const rest =
          ending === "hang"
            ? Stream.never
            : // Failing with `undefined` drops the connection without Bun printing the error.
              Stream.fromEffect(Effect.andThen(ending.drop, Effect.fail(undefined)));

        return HttpServerResponse.stream(
          Stream.concat(Stream.make(new TextEncoder().encode(text)), rest),
          { status, contentType },
        );
      }),
    ),
    // Test fixture: a body that is not JSON is a bug in the code under test.
    Effect.orDie,
  );

  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/chat/completions", answer),
    HttpRouter.add("POST", "/responses", answer),
    HttpRouter.add(
      "GET",
      "/models",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        modelRequests.push({ path: "/models", headers: request.headers, body: {} });

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
  );

  const usageRoute = HttpRouter.add(
    "GET",
    "/usage",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      usageRequests.push({ path: "/usage", headers: request.headers, body: {} });

      return HttpServerResponse.text(usageAnswer.body, {
        status: usageAnswer.status,
        contentType: "application/json",
      });
    }),
  );

  const server = yield* Layer.build(
    HttpRouter.serve(Layer.merge(routes, usageRoute)).pipe(
      Layer.provideMerge(BunHttpServer.layer({ port: 0 })),
    ),
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
    usage: (body: object, status = 200) =>
      void (usageAnswer = { status, body: JSON.stringify(body) }),
    /** Waits until at least `count` `GET /models` requests have arrived. */
    modelsReceived: (count: number) =>
      Effect.gen(function* () {
        if (modelRequests.length >= count) return;
        const deferred = yield* Deferred.make<void>();
        waiters.push({ count, deferred });
        yield* Deferred.await(deferred);
      }),
    /** Answers every completion request. */
    respond: (reply: ProviderReply) => void (handler = reply),
    /**
     * Lists `models` at `GET /models`, each an id or a full model object; until
     * then, it answers 500.
     */
    models: (models: ReadonlyArray<string | Record<string, unknown>>) =>
      void (modelList = models.map((model) =>
        typeof model === "string" ? { id: model, object: "model" } : model,
      )),
  };
});

/** A running fake provider, as `startFakeProvider` gives it. */
export type FakeProvider = Effect.Success<typeof startFakeProvider>;
