import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ChatRequest, toResponsesRequest } from "./chat-request.ts";

const translate = (chat: Schema.Json) =>
  toResponsesRequest(Schema.decodeUnknownSync(ChatRequest)(chat));

const parts = (...texts: ReadonlyArray<string>) => texts.map((text) => ({ type: "text", text }));

describe("toResponsesRequest", () => {
  it("moves system messages into instructions and user text into input", () => {
    expect(
      translate({
        model: "gpt-6-astra",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "developer", content: "Answer in English." },
          { role: "user", content: "hi" },
        ],
      }),
    ).toEqual({
      model: "gpt-6-astra",
      instructions: "Be brief.\n\nAnswer in English.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
  });

  it("keeps the turns of a conversation in order, with assistant replies as output text", () => {
    expect(
      translate({
        model: "gpt-6-astra",
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
        model: "gpt-6-astra",
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

  it("carries an image's detail over", () => {
    expect(
      translate({
        model: "gpt-6-astra",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://x.test/a.png", detail: "low" } },
            ],
          },
        ],
      }).input,
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "https://x.test/a.png", detail: "low" }],
      },
    ]);
  });

  it("turns assistant tool calls and tool results into function call items", () => {
    expect(
      translate({
        model: "gpt-6-astra",
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

  it("reads system, assistant and tool content given as text parts", () => {
    expect(
      translate({
        model: "gpt-6-astra",
        messages: [
          { role: "system", content: parts("Be ", "brief.") },
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: parts("Checking."),
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "weather", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: parts("Sun", "ny") },
        ],
      }),
    ).toEqual({
      model: "gpt-6-astra",
      instructions: "Be brief.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Weather in Paris?" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Checking." }],
        },
        { type: "function_call", call_id: "call_1", name: "weather", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "Sunny" },
      ],
    });
  });

  it("flattens function tools and a forced tool choice", () => {
    const parameters = { type: "object", properties: { city: { type: "string" } } };
    expect(
      translate({
        model: "gpt-6-astra",
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

  it("sends a function tool that leaves out strict as not strict, as Chat Completions reads it", () => {
    expect(
      translate({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "weather" } }],
      }),
    ).toMatchObject({ tools: [{ type: "function", name: "weather", strict: false }] });
  });

  it("gives a function tool that leaves out its parameters an empty object schema", () => {
    expect(
      translate({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "now" } }],
      }),
    ).toMatchObject({
      tools: [{ type: "function", name: "now", parameters: { type: "object", properties: {} } }],
    });
  });

  it("passes a tool choice mode through", () => {
    expect(
      translate({ model: "gpt-6-astra", messages: [], tool_choice: "required" }),
    ).toMatchObject({
      tool_choice: "required",
    });
  });

  it("asks for structured output in the Responses text format", () => {
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    expect(
      translate({
        model: "gpt-6-astra",
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
      translate({ model: "gpt-6-astra", messages: [], response_format: { type: "json_object" } }),
    ).toMatchObject({ text: { format: { type: "json_object" } } });
  });

  it("carries the reasoning effort and streaming over", () => {
    expect(
      translate({ model: "gpt-6-astra", messages: [], reasoning_effort: "high", stream: true }),
    ).toMatchObject({ reasoning: { effort: "high" }, stream: true });
  });

  it("accepts the sampling and limit options Codex refuses, and leaves them out", () => {
    expect(
      translate({
        model: "gpt-6-astra",
        messages: [],
        max_tokens: 100,
        max_completion_tokens: 100,
        temperature: 0.2,
        top_p: 0.9,
        user: "u-1",
        metadata: { run: "1" },
      }),
    ).toEqual({ model: "gpt-6-astra", instructions: "", input: [] });
  });
});
