import { Schema } from "effect";

const InstructionMessage = Schema.Struct({
  role: Schema.Literals(["system", "developer"]),
  content: Schema.String,
});
const UserMessage = Schema.Struct({ role: Schema.Literal("user"), content: Schema.String });
const Message = Schema.Union([InstructionMessage, UserMessage]);

export const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Message),
});
export type ChatRequest = typeof ChatRequest.Type;

/** The Responses API request equivalent to a Chat Completions request. */
export const toResponsesRequest = (chat: ChatRequest): Record<string, unknown> => {
  const instructions = chat.messages.filter(Schema.is(InstructionMessage));
  const input = chat.messages.filter(Schema.is(UserMessage)).map((message) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message.content }],
  }));
  return {
    model: chat.model,
    instructions: instructions.map((message) => message.content).join("\n\n"),
    input,
  };
};
