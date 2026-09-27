// Test-only: Codex stream and usage payloads, for tests that need the raw bytes.
import type { Schema } from "effect";

/** A Responses stream event, named by its `type`. */
export type CodexEvent = { type: string } & Schema.JsonObject;

/** Formats Responses stream events as the SSE the Codex backend sends. */
export const sse = (events: ReadonlyArray<CodexEvent>) =>
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
