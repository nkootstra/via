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
});
