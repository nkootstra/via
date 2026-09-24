import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ChatRequest, toResponsesRequest } from "./chat-request.ts";

const translate = (chat: unknown) =>
  toResponsesRequest(Schema.decodeUnknownSync(ChatRequest)(chat));

describe("toResponsesRequest", () => {
  it("moves system messages into instructions and user text into input", () => {
    expect(
      translate({
        model: "gpt-5.5",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "developer", content: "Answer in English." },
          { role: "user", content: "hi" },
        ],
      }),
    ).toEqual({
      model: "gpt-5.5",
      instructions: "Be brief.\n\nAnswer in English.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
  });

  it("keeps the turns of a conversation in order, with assistant replies as output text", () => {
    expect(
      translate({
        model: "gpt-5.5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "bye" },
        ],
      }).input,
    ).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "bye" }] },
    ]);
  });

  it("translates text and image parts of a user message", () => {
    expect(
      translate({
        model: "gpt-5.5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }).input,
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is this?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    ]);
  });

  it("turns assistant tool calls and tool results into function call items", () => {
    expect(
      translate({
        model: "gpt-5.5",
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
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
          { role: "tool", tool_call_id: "call_1", content: "Sunny" },
        ],
      }).input,
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Weather in Paris?" }],
      },
      { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Paris"}' },
      { type: "function_call_output", call_id: "call_1", output: "Sunny" },
    ]);
  });

  it("flattens function tools and a forced tool choice", () => {
    const parameters = { type: "object", properties: { city: { type: "string" } } };
    expect(
      translate({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "weather", description: "Current weather", parameters, strict: true },
          },
        ],
        tool_choice: { type: "function", function: { name: "weather" } },
        parallel_tool_calls: false,
      }),
    ).toMatchObject({
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Current weather",
          parameters,
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "weather" },
      parallel_tool_calls: false,
    });
  });

  it("passes a tool choice mode through", () => {
    expect(translate({ model: "gpt-5.5", messages: [], tool_choice: "required" })).toMatchObject({
      tool_choice: "required",
    });
  });

  it("asks for structured output in the Responses text format", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    expect(
      translate({
        model: "gpt-5.5",
        messages: [],
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", schema, strict: true },
        },
      }),
    ).toMatchObject({
      text: { format: { type: "json_schema", name: "answer", schema, strict: true } },
    });
    expect(
      translate({ model: "gpt-5.5", messages: [], response_format: { type: "json_object" } }),
    ).toMatchObject({ text: { format: { type: "json_object" } } });
  });

  it("carries the reasoning effort and streaming over", () => {
    expect(
      translate({ model: "gpt-5.5", messages: [], reasoning_effort: "high", stream: true }),
    ).toMatchObject({ reasoning: { effort: "high" }, stream: true });
  });
});
