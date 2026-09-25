// Test-only: a scriptable OpenAI-compatible provider, such as OpenRouter or
// OpenCode Go, that records every request it receives.
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
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

type Answer = { status: number; contentType: string; body: string };

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
};

const unscripted: ProviderReply = providerReply.json(
  { error: { message: "fake provider: unscripted" } },
  599,
);

const Body = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Starts the fake for the current scope. It answers `POST /chat/completions`
 * and `POST /responses` with the `respond` handler (500 until one is set) and
 * `GET /models` with the ids given to `models`.
 */
export const startFakeProvider = Effect.gen(function* () {
  const requests: Array<ProviderRequest> = [];
  let handler = unscripted;
  let modelIds: ReadonlyArray<string> | undefined;

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
        const { status, contentType, body: text } = handler(recorded);
        return HttpServerResponse.text(text, { status, contentType });
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
        requests.push({ path: "/models", headers: request.headers, body: {} });
        return modelIds === undefined
          ? HttpServerResponse.text("", { status: 500 })
          : HttpServerResponse.jsonUnsafe({
              object: "list",
              data: modelIds.map((id) => ({ id, object: "model" })),
            });
      }),
    ),
  );

  const server = yield* Layer.build(
    HttpRouter.serve(routes).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 }))),
  );
  return {
    /** The provider's base URL, as config.yaml's `baseUrl`. */
    url: yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server)),
    /** Every request received so far, in order. */
    requests: requests as ReadonlyArray<ProviderRequest>,
    /** Answers every completion request. */
    respond: (reply: ProviderReply) => void (handler = reply),
    /** Lists `ids` at `GET /models`; until then, it answers 500. */
    models: (ids: ReadonlyArray<string>) => void (modelIds = ids),
  };
});

/** A running fake provider, as `startFakeProvider` gives it. */
export type FakeProvider = Effect.Success<typeof startFakeProvider>;
