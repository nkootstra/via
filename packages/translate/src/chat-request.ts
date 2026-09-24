import { Schema } from "effect";

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ImagePart = Schema.Struct({
  type: Schema.Literal("image_url"),
  image_url: Schema.Struct({ url: Schema.String }),
});
const UserPart = Schema.Union([TextPart, ImagePart]);

const InstructionMessage = Schema.Struct({
  role: Schema.Literals(["system", "developer"]),
  content: Schema.String,
});
const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(UserPart)]),
});
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.String,
});
const Message = Schema.Union([InstructionMessage, UserMessage, AssistantMessage]);

export const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Message),
});
export type ChatRequest = typeof ChatRequest.Type;

const userPart = (part: typeof UserPart.Type) =>
  Schema.is(TextPart)(part)
    ? { type: "input_text", text: part.text }
    : { type: "input_image", image_url: part.image_url.url };

/** The Responses input items a chat message becomes; instructions become none. */
const inputItems = (message: typeof Message.Type): ReadonlyArray<object> => {
  if (Schema.is(InstructionMessage)(message)) return [];
  if (Schema.is(UserMessage)(message)) {
    const parts =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    return [{ type: "message", role: "user", content: parts.map(userPart) }];
  }
  return [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: message.content }],
    },
  ];
};

/** The Responses API request equivalent to a Chat Completions request. */
export const toResponsesRequest = (chat: ChatRequest): Record<string, unknown> => ({
  model: chat.model,
  instructions: chat.messages
    .filter(Schema.is(InstructionMessage))
    .map((message) => message.content)
    .join("\n\n"),
  input: chat.messages.flatMap(inputItems),
});
