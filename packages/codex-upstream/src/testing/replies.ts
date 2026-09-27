// Test-only: what the fake Codex answers. Each builder turns a request into a
// plan the fake serves as-is, so a test can script every way Codex answers,
// including the ways it fails.
import { type Deferred, Predicate, type Schema } from "effect";
import { type CodexEvent, sse } from "./streams.ts";

/** One request as via sent it: nothing redacted, nothing converted. */
export type CodexRequest = {
  path: string;
  query: Readonly<Record<string, string>>;
  headers: Readonly<Record<string, string | undefined>>;
  body: Schema.JsonObject;
};

/** What the fake does with one request. */
export type Plan = {
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

/** How the fake answers one request. */
export type Reply = (request: CodexRequest) => Plan;

/** Each event is its own chunk, so a reply can be cut off between any two. */
const stream = (events: ReadonlyArray<CodexEvent>): Plan => ({
  status: 200,
  headers: {},
  contentType: "text/event-stream",
  chunks: events.map((event, index) => sse([{ ...event, sequence_number: index }])),
  ending: "close",
});

/** A body as the fake sends it: a string as-is, so it can be malformed on purpose. */
export const jsonText = (body: Schema.Json) =>
  Predicate.isString(body) ? body : JSON.stringify(body);

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

/** The response envelope, in the public Responses API shape. */
const envelope = (request: CodexRequest) => ({
  id: "resp_fake",
  object: "response",
  created_at: 1_700_000_000,
  model: Predicate.isString(request.body["model"]) ? request.body["model"] : "gpt-6-astra",
});

/** The events that open every response. */
const started = (response: ReturnType<typeof envelope>): ReadonlyArray<CodexEvent> => [
  { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
  { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } },
];

/** A response that streams `events`, then completes with `output`. */
const lifecycle = (
  request: CodexRequest,
  events: ReadonlyArray<CodexEvent>,
  output: ReadonlyArray<Schema.Json>,
) => {
  const response = envelope(request);

  return stream([
    ...started(response),
    ...events,
    { type: "response.completed", response: { ...response, status: "completed", output, usage } },
  ]);
};

/** `inner`, cut off after `events` frames and ending as `ending` says. */
const cut =
  (ending: Plan["ending"]) =>
  (inner: Reply, events: number): Reply =>
  (request) => {
    const plan = inner(request);

    return { ...plan, chunks: plan.chunks.slice(0, events), ending };
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
        [done],
      );
    },

  /** Codex calls the tool `name` with `args`. */
  toolCall:
    (name: string, args: Schema.Json): Reply =>
    (request) => {
      const argumentsJson = JSON.stringify(args);
      const item = { id: "fc_fake", type: "function_call", call_id: "call_fake", name };
      const done = { ...item, status: "completed", arguments: argumentsJson };
      const at = { item_id: item.id, output_index: 0 };

      return lifecycle(
        request,
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
        ...started(response),
        {
          type: "response.failed",
          response: { ...response, status: "failed", error: { code, message }, usage: null },
        },
      ]);
    },

  /** A plain HTTP error, as Codex sends before any stream starts. */
  error:
    (status: number, body: Schema.Json, headers: Record<string, string> = {}): Reply =>
    () => ({
      status,
      headers,
      contentType: "application/json",
      chunks: [jsonText(body)],
      ending: "close",
    }),

  /** `inner`, cut off cleanly after `events` frames, with no terminal event. */
  truncated: cut("close"),

  /** `inner`, with the connection broken after `events` frames. */
  hangUp: cut("hangUp"),

  /** `inner`, going quiet after `events` frames with the connection left open. */
  stalled: cut("stall"),

  /** `inner`, held back until `gate` completes. */
  held:
    (gate: Deferred.Deferred<void>, inner: Reply): Reply =>
    (request) => ({ ...inner(request), gate }),
};
