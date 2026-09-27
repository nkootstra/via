import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { CompletedResponse, toChatCompletion } from "./chat-response.ts";

const translate = (response: unknown) =>
  toChatCompletion(Schema.decodeUnknownSync(CompletedResponse)(response));

const usage = {
  input_tokens: 12,
  output_tokens: 5,
  total_tokens: 17,
  output_tokens_details: { reasoning_tokens: 2 },
};

describe("toChatCompletion", () => {
  it("turns the output text into the assistant message, with token usage", () => {
    expect(
      translate({
        id: "resp_1",
        created_at: 1_700_000_000,
        model: "gpt-6-astra",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Hello", annotations: [] },
              { type: "output_text", text: " there", annotations: [] },
            ],
          },
        ],
        usage,
      }),
    ).toEqual({
      id: "resp_1",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "gpt-6-astra",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello there" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    });
  });

  it("turns function calls into tool calls and finishes for them", () => {
    const completion = translate({
      id: "resp_1",
      created_at: 1_700_000_000,
      model: "gpt-6-astra",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "weather",
          arguments: '{"city":"Paris"}',
        },
      ],
      usage,
    });

    expect(completion.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    });
  });

  it.each([
    { reason: "max_output_tokens", finish: "length" },
    { reason: "content_filter", finish: "content_filter" },
  ])("finishes an incomplete response ($reason) with $finish", ({ reason, finish }) => {
    const completion = translate({
      id: "resp_1",
      created_at: 1_700_000_000,
      model: "gpt-6-astra",
      status: "incomplete",
      incomplete_details: { reason },
      output: [{ type: "message", content: [{ type: "output_text", text: "Hel" }] }],
      usage,
    });

    expect(completion.choices[0]).toMatchObject({
      message: { content: "Hel" },
      finish_reason: finish,
    });
  });
});
