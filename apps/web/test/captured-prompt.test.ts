import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { markersIn, promptOf } from "../src/lib/captured-prompt.ts";

describe("a captured prompt", () => {
  it("reads a chat completion: its parameters, tools and messages by role", () => {
    const prompt = promptOf({
      model: "gpt-6-astra",
      max_completion_tokens: 4_096,
      temperature: 0.2,
      reasoning_effort: "high",
      stream: true,
      tools: [
        { type: "function", function: { name: "read_file" } },
        { type: "function", function: { name: "bash" } },
      ],
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
      ],
    });

    expect(Option.isSome(prompt)).toBe(true);
    const read = Option.getOrThrow(prompt);

    expect(read.format).toBe("chat");
    expect(read.parameters).toEqual([
      ["Model", "gpt-6-astra"],
      ["Max tokens", "4096"],
      ["Reasoning", "high"],
      ["Temperature", "0.2"],
      ["Stream", "yes"],
    ]);
    expect(read.tools).toEqual(["read_file", "bash"]);
    expect(read.messages).toEqual([
      { role: "system", parts: [{ kind: "text", text: "You are a coding agent." }] },
      { role: "user", parts: [{ kind: "text", text: "Fix the bug" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "toolCall",
            name: "read_file",
            id: Option.some("call_1"),
            arguments: '{\n  "path": "a.ts"\n}',
          },
        ],
      },
      {
        role: "tool",
        parts: [{ kind: "toolResult", id: Option.some("call_1"), text: "export const a = 1;" }],
      },
    ]);
  });

  it("reads a Responses request: its instructions, input items and reasoning", () => {
    const read = Option.getOrThrow(
      promptOf({
        model: "gpt-6-astra",
        instructions: "Be terse.",
        max_output_tokens: 1_000,
        reasoning: { effort: "medium", summary: "auto" },
        tools: [{ type: "function", name: "shell" }, { type: "web_search" }],
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Look at this" },
              { type: "input_image", image_url: "[image: png, 412 KB]" },
            ],
          },
          { type: "reasoning", summary: [{ type: "summary_text", text: "Thinking it over" }] },
          { type: "function_call", call_id: "c1", name: "shell", arguments: "ls" },
          { type: "function_call_output", call_id: "c1", output: "a.ts" },
          { role: "assistant", content: "Done." },
        ],
      }),
    );

    expect(read.format).toBe("responses");
    expect(read.parameters).toEqual([
      ["Model", "gpt-6-astra"],
      ["Max tokens", "1000"],
      ["Reasoning", "medium"],
    ]);
    expect(read.tools).toEqual(["shell", "web_search"]);
    expect(read.messages).toEqual([
      { role: "instructions", parts: [{ kind: "text", text: "Be terse." }] },
      {
        role: "user",
        parts: [
          { kind: "text", text: "Look at this" },
          { kind: "image", label: "[image: png, 412 KB]" },
        ],
      },
      { role: "assistant", parts: [{ kind: "reasoning", text: "Thinking it over" }] },
      {
        role: "assistant",
        parts: [{ kind: "toolCall", name: "shell", id: Option.some("c1"), arguments: "ls" }],
      },
      { role: "tool", parts: [{ kind: "toolResult", id: Option.some("c1"), text: "a.ts" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Done." }] },
    ]);
  });

  it("takes a Responses input given as plain text as the user's", () => {
    const read = Option.getOrThrow(promptOf({ model: "m", input: "Hello" }));

    expect(read.messages).toEqual([{ role: "user", parts: [{ kind: "text", text: "Hello" }] }]);
  });

  it("keeps a part it doesn't know as its JSON, rather than dropping it", () => {
    const read = Option.getOrThrow(
      promptOf({
        messages: [
          { role: "user", content: [{ type: "input_audio", input_audio: { format: "wav" } }] },
        ],
      }),
    );

    expect(read.messages[0]?.parts).toEqual([
      {
        kind: "other",
        json: '{\n  "type": "input_audio",\n  "input_audio": {\n    "format": "wav"\n  }\n}',
      },
    ]);
  });

  it("is none for a body of any other shape, which is shown as JSON", () => {
    expect(Option.isNone(promptOf({ prompt: "legacy completion" }))).toBe(true);
    expect(Option.isNone(promptOf("[truncated]"))).toBe(true);
    expect(Option.isNone(promptOf({ messages: "not a list" }))).toBe(true);
  });
});

describe("the markers in a captured prompt's text", () => {
  it("splits redactions and images out of the text around them", () => {
    expect(markersIn("key [redacted:openai-key] and [image: png, 412 KB]!")).toEqual([
      { kind: "text", text: "key " },
      { kind: "redacted", text: "[redacted:openai-key]" },
      { kind: "text", text: " and " },
      { kind: "image", text: "[image: png, 412 KB]" },
      { kind: "text", text: "!" },
    ]);
  });

  it("leaves text without markers whole, brackets and all", () => {
    expect(markersIn("an [array] of [1, 2]")).toEqual([
      { kind: "text", text: "an [array] of [1, 2]" },
    ]);
    expect(markersIn("")).toEqual([]);
  });
});
