import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { CompletedResponse, toChatCompletion } from "./chat-response.ts";

const translate = (response: Schema.Json) =>
  toChatCompletion(Schema.decodeUnknownSync(CompletedResponse)(response));

const usage = { input_tokens: 12, output_tokens: 5, total_tokens: 17 };

const withUsage = (reported: Schema.Json) =>
  translate({
    id: "resp_1",
    created_at: 1_700_000_000,
    model: "gpt-6-astra",
    output: [],
    usage: reported,
  }).usage;

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

  it("puts the reasoning summaries in reasoning content, a blank line between parts", () => {
    const completion = translate({
      id: "resp_1",
      created_at: 1_700_000_000,
      model: "gpt-6-astra",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "Weighing it" },
            { type: "summary_text", text: "" },
            { type: "summary_text", text: "Decided" },
          ],
          encrypted_content: "gAAA",
        },
        { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "Again" }] },
        { type: "message", content: [{ type: "output_text", text: "Hi" }] },
      ],
      usage,
    });

    expect(completion.choices[0]?.message).toEqual({
      role: "assistant",
      content: "Hi",
      reasoning_content: "Weighing it\n\nDecided\n\nAgain",
    });
  });

  it("puts a refusal in the message's refusal, with no content", () => {
    const completion = translate({
      id: "resp_1",
      created_at: 1_700_000_000,
      model: "gpt-6-astra",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I can't help with that." }],
        },
      ],
      usage,
    });

    expect(completion.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: null, refusal: "I can't help with that." },
      finish_reason: "stop",
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

  it("reports cached and reasoning tokens as prompt and completion token details", () => {
    expect(
      withUsage({
        ...usage,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 2 },
      }),
    ).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 8 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  });

  it.each([
    { case: "leaves it out", reported: {} },
    { case: "sends null", reported: { usage: null } },
  ])("answers with no usage when Codex $case", ({ reported }) => {
    const completion = translate({
      id: "resp_1",
      created_at: 1_700_000_000,
      model: "gpt-6-astra",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
      ...reported,
    });

    expect(completion.choices[0]).toMatchObject({ message: { content: "Hello" } });
    expect(completion).not.toHaveProperty("usage");
  });

  it("leaves out the token details Codex did not send", () => {
    expect(withUsage({ ...usage, input_tokens_details: { cached_tokens: 8 } })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 8 },
    });

    expect(
      withUsage({ ...usage, input_tokens_details: null, output_tokens_details: null }),
    ).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  });

  it("adds up the total when the upstream leaves it out", () => {
    expect(withUsage({ input_tokens: 12, output_tokens: 5 })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    });
  });
});
