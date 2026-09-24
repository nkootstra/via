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
});
