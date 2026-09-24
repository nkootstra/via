// Test-only: a local stand-in for chatgpt.com/backend-api/codex, exported as `./testing`.
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

const response = { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.5" };

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

/** Serves POST /responses, answering each request with `reply`. */
export const fakeUpstream = (reply: (request: RecordedRequest) => FakeReply) =>
  HttpRouter.serve(
    HttpRouter.add(
      "POST",
      "/responses",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* HttpServerRequest.schemaBodyJson(
          Schema.Record(Schema.String, Schema.Unknown),
        );
        const { status, headers, body: text } = reply({ headers: request.headers, body });
        return HttpServerResponse.text(text, {
          status,
          headers,
          contentType: status === 200 ? "text/event-stream" : "application/json",
        });
        // Test fixture: a body that is not JSON is a bug in the code under test.
      }).pipe(Effect.orDie),
    ),
  ).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 })));

/** The base URL of the running fake upstream. */
export const upstreamUrl = HttpServer.addressFormattedWith(Effect.succeed);
