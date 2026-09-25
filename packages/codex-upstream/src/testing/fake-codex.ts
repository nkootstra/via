// Test-only: a scriptable stand-in for chatgpt.com/backend-api. Replies are
// queued per test, so each test says exactly what Codex answers, including the
// ways it fails. The golden fixtures in ./fixtures come from openai/codex.
import { BunHttpServer } from "@effect/platform-bun";
import { Clock, Deferred, Effect, Layer, Schema, Stream } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { usagePayload } from "./streams.ts";

/** One request as via sent it: nothing redacted, nothing converted. */
export type CodexRequest = {
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Record<string, unknown>;
};

/** What the fake does with one request. */
type Plan = {
  status: number;
  headers: Record<string, string>;
  contentType: string;
  /** SSE frames, or a single JSON body for an error. */
  chunks: ReadonlyArray<string>;
  /**
   * After the last chunk, `hangUp` breaks the connection and `stall` keeps it
   * open without sending anything more.
   */
  ending: "close" | "hangUp" | "stall";
  /** The response is not sent until this completes. */
  gate?: Deferred.Deferred<void>;
};

export type Reply = (request: CodexRequest) => Plan;

type Event = { type: string } & Record<string, unknown>;

const frame = (event: Event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const stream = (events: ReadonlyArray<Event>): Plan => ({
  status: 200,
  headers: {},
  contentType: "text/event-stream",
  chunks: events.map((event, index) => frame({ ...event, sequence_number: index })),
  ending: "close",
});

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

/** The response lifecycle around `items`, in the public Responses API shape. */
const envelope = (request: CodexRequest) => ({
  id: "resp_fake",
  object: "response",
  created_at: 1_700_000_000,
  model: typeof request.body["model"] === "string" ? request.body["model"] : "gpt-6-astra",
});

const lifecycle = (
  request: CodexRequest,
  items: ReadonlyArray<ReadonlyArray<Event>>,
  output: ReadonlyArray<unknown>,
) => {
  const response = envelope(request);
  return stream([
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } },
    ...items.flat(),
    {
      type: "response.completed",
      response: { ...response, status: "completed", output, usage },
    },
  ]);
};

export const reply = {
  /** Codex answers with an assistant message. */
  text:
    (text: string): Reply =>
    (request) => {
      const item = { id: "msg_fake", type: "message", role: "assistant" };
      const part = { type: "output_text", text, annotations: [] };
      const at = { item_id: item.id, output_index: 0, content_index: 0 };
      const done = { ...item, status: "completed", content: [part] };
      return lifecycle(
        request,
        [
          [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            },
            { type: "response.content_part.added", ...at, part: { ...part, text: "" } },
            { type: "response.output_text.delta", ...at, delta: text },
            { type: "response.output_text.done", ...at, text },
            { type: "response.content_part.done", ...at, part },
            { type: "response.output_item.done", output_index: 0, item: done },
          ],
        ],
        [done],
      );
    },

  /** Codex calls the tool `name` with `args`. */
  toolCall:
    (name: string, args: unknown): Reply =>
    (request) => {
      const argumentsJson = JSON.stringify(args);
      const item = { id: "fc_fake", type: "function_call", call_id: "call_fake", name };
      const done = { ...item, status: "completed", arguments: argumentsJson };
      const at = { item_id: item.id, output_index: 0 };
      return lifecycle(
        request,
        [
          [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", arguments: "" },
            },
            { type: "response.function_call_arguments.delta", ...at, delta: argumentsJson },
            { type: "response.function_call_arguments.done", ...at, arguments: argumentsJson },
            { type: "response.output_item.done", output_index: 0, item: done },
          ],
        ],
        [done],
      );
    },

  /** Replays a raw SSE body, such as a golden fixture, frame by frame. */
  sse:
    (body: string): Reply =>
    () => ({
      ...stream([]),
      chunks: body
        .split(/\n\n+/)
        .filter((chunk) => chunk.trim() !== "")
        .map((chunk) => `${chunk}\n\n`),
    }),

  /** Codex starts the response, then fails it in-stream with `code`. */
  failed:
    (code: string, message: string): Reply =>
    (request) => {
      const response = envelope(request);
      return stream([
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        {
          type: "response.in_progress",
          response: { ...response, status: "in_progress", output: [] },
        },
        {
          type: "response.failed",
          response: { ...response, status: "failed", error: { code, message }, usage: null },
        },
      ]);
    },

  /** A plain HTTP error, as Codex sends before any stream starts. */
  error:
    (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
    () => ({
      status,
      headers,
      contentType: "application/json",
      chunks: [typeof body === "string" ? body : JSON.stringify(body)],
      ending: "close",
    }),

  /** `inner`, cut off cleanly after `events` frames, with no terminal event. */
  truncated:
    (inner: Reply, events: number): Reply =>
    (request) => {
      const plan = inner(request);
      return { ...plan, chunks: plan.chunks.slice(0, events) };
    },

  /** `inner`, with the connection broken after `events` frames. */
  hangUp:
    (inner: Reply, events: number): Reply =>
    (request) => {
      const plan = inner(request);
      return { ...plan, chunks: plan.chunks.slice(0, events), ending: "hangUp" };
    },

  /** `inner`, going quiet after `events` frames with the connection left open. */
  stalled:
    (inner: Reply, events: number): Reply =>
    (request) => {
      const plan = inner(request);
      return { ...plan, chunks: plan.chunks.slice(0, events), ending: "stall" };
    },

  /** `inner`, held back until `gate` completes. */
  held:
    (gate: Deferred.Deferred<void>, inner: Reply): Reply =>
    (request) => ({ ...inner(request), gate }),
};

const unscripted: Reply = (request) =>
  reply.error(599, {
    error: { message: `fake Codex: unscripted request to ${request.path}`, type: "unscripted" },
  })(request);

// Bun only resets the socket when a body fails after the sent frames were
// flushed; failing straight away ends the response cleanly and empty. The pause
// runs on the real clock so a test's TestClock can't freeze it. Bun logs the
// failure; a plain string keeps that to one line instead of a stack trace.
const hangUp = Stream.fromEffect(
  Effect.sleep("20 millis").pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())),
).pipe(Stream.drain, Stream.concat(Stream.fail("fake Codex hung up")));

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

const Body = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Starts the fake for the current scope. Replies are served per request in
 * this order: the queue for the request's `chatgpt-account-id`, then the
 * shared queue, then the `respond` handler; a request none of them answers
 * fails with 599 so a missing script never passes silently.
 */
export const startFakeCodex = Effect.gen(function* () {
  const requests: Array<CodexRequest> = [];
  const shared: Array<Reply> = [];
  const perAccount = new Map<string, Array<Reply>>();
  const usageByAccount = new Map<string, { status: number; body: string }>();
  let catalog: string | undefined;
  const catalogByAccount = new Map<string, string>();
  const waiters: Array<{ count: number; deferred: Deferred.Deferred<void> }> = [];
  let handler: ((request: CodexRequest) => Reply) | undefined;

  const record = (body: Record<string, unknown>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const recorded = {
        path: new URL(request.url, "http://fake").pathname,
        headers: request.headers,
        body,
      };
      requests.push(recorded);
      for (const waiter of waiters) {
        if (requests.length >= waiter.count) yield* Deferred.succeed(waiter.deferred, undefined);
      }
      return recorded;
    });

  const next = (request: CodexRequest): Reply => {
    const account = request.headers["chatgpt-account-id"];
    return (
      (account === undefined ? undefined : perAccount.get(account)?.shift()) ??
      shared.shift() ??
      handler?.(request) ??
      unscripted
    );
  };

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/codex/responses",
      HttpServerRequest.schemaBodyJson(Body).pipe(
        Effect.flatMap(record),
        Effect.flatMap((request) => respond(next(request)(request))),
        // Test fixture: a body that is not JSON is a bug in the code under test.
        Effect.orDie,
      ),
    ),
    HttpRouter.add(
      "GET",
      "/wham/usage",
      Effect.gen(function* () {
        const request = yield* record({});
        const account = request.headers["chatgpt-account-id"];
        const { status, body } = (account === undefined
          ? undefined
          : usageByAccount.get(account)) ?? { status: 200, body: JSON.stringify(usagePayload) };
        return HttpServerResponse.text(body, { status, contentType: "application/json" });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/codex/models",
      Effect.gen(function* () {
        const request = yield* record({});
        const account = request.headers["chatgpt-account-id"];
        const body = (account === undefined ? undefined : catalogByAccount.get(account)) ?? catalog;
        return body === undefined
          ? yield* respond(unscripted(request))
          : HttpServerResponse.text(body, { contentType: "application/json" });
      }),
    ),
  );

  const server = yield* Layer.build(
    HttpRouter.serve(routes).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 }))),
  );
  const url = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server));

  return {
    /** Where via should send Codex traffic (`VIA_CODEX_BASE_URL`). */
    url,
    /** Every request received so far, in order. */
    requests: requests as ReadonlyArray<CodexRequest>,
    /** Queues replies for any account, served in order. */
    script: (...replies: ReadonlyArray<Reply>) => void shared.push(...replies),
    /** Queues replies for one ChatGPT account, served before the shared queue. */
    forAccount: (account: string, ...replies: ReadonlyArray<Reply>) =>
      void perAccount.set(account, [...(perAccount.get(account) ?? []), ...replies]),
    /** Answers every request the queues don't. */
    respond: (answer: (request: CodexRequest) => Reply) => void (handler = answer),
    /** Sets one account's `/wham/usage` answer, a refusal when `status` is not 200. */
    usage: (account: string, body: string | object, status = 200) =>
      void usageByAccount.set(account, {
        status,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    /**
     * Sets the `/codex/models` answer, for one account when `account` is given;
     * until then, the catalog is unscripted.
     */
    models: (body: string | object, account?: string) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      if (account === undefined) catalog = text;
      else catalogByAccount.set(account, text);
    },
    /** Waits until at least `count` requests have arrived. */
    received: (count: number) =>
      Effect.gen(function* () {
        if (requests.length >= count) return;
        const deferred = yield* Deferred.make<void>();
        waiters.push({ count, deferred });
        yield* Deferred.await(deferred);
      }),
  };
});

/** A running fake Codex, as `startFakeCodex` gives it. */
export type FakeCodex = Effect.Success<typeof startFakeCodex>;
