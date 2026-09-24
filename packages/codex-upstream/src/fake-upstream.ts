// Test-only: a local stand-in for chatgpt.com/backend-api, exported as `./testing`.
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

export type RecordedRequest = {
  headers: Readonly<Record<string, string | undefined>>;
  body: Record<string, unknown>;
};

export type FakeReply = { status: number; headers?: Record<string, string>; body: string };

/** Formats Responses stream events as the SSE the Codex backend sends. */
export const sse = (events: ReadonlyArray<{ type: string } & Record<string, unknown>>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const response = {
  id: "resp_1",
  object: "response",
  created_at: 1_700_000_000,
  model: "gpt-6-astra",
};

/** A stream in which Codex answers with `text` and completes. */
export const completedStream = (text: string) =>
  sse([
    { type: "response.created", response: { ...response, status: "in_progress" } },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);

/** A `/wham/usage` answer: 12% of the 5-hour window and 40% of the weekly window used. */
export const usagePayload = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3_600,
      reset_at: 1_700_003_600,
    },
    secondary_window: {
      used_percent: 40,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
      reset_at: 1_700_086_400,
    },
  },
};

const record = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body =
    request.method === "GET"
      ? {}
      : yield* HttpServerRequest.schemaBodyJson(Schema.Record(Schema.String, Schema.Unknown));
  return { headers: request.headers, body };
});

const answer = ({ status, headers, body }: FakeReply, contentType: string) =>
  HttpServerResponse.text(body, {
    status,
    headers,
    contentType: status === 200 ? contentType : "application/json",
  });

/**
 * Serves POST /codex/responses, answering each request with `reply`, and
 * GET /wham/usage, answering with `usage` (by default `usagePayload`).
 */
export const fakeUpstream = (
  reply: (request: RecordedRequest) => FakeReply,
  usage: (request: RecordedRequest) => FakeReply = () => ({
    status: 200,
    body: JSON.stringify(usagePayload),
  }),
) =>
  HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add(
        "POST",
        "/codex/responses",
        // Test fixture: a body that is not JSON is a bug in the code under test.
        record.pipe(
          Effect.map((request) => answer(reply(request), "text/event-stream")),
          Effect.orDie,
        ),
      ),
      HttpRouter.add(
        "GET",
        "/wham/usage",
        record.pipe(
          Effect.map((request) => answer(usage(request), "application/json")),
          Effect.orDie,
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 })));

/** The base URL of the running fake upstream. */
export const upstreamUrl = HttpServer.addressFormattedWith(Effect.succeed);
