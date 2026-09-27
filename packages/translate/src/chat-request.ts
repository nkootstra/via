import { Schema } from "effect";

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ImagePart = Schema.Struct({
  type: Schema.Literal("image_url"),
  image_url: Schema.Struct({ url: Schema.String }),
});

const UserPart = Schema.Union([TextPart, ImagePart]);

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

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
  content: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
});

const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  tool_call_id: Schema.String,
  content: Schema.String,
});

const Message = Schema.Union([InstructionMessage, UserMessage, AssistantMessage, ToolMessage]);

const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
    parameters: Schema.optionalKey(Schema.Unknown),
    strict: Schema.optionalKey(Schema.Boolean),
  }),
});

const ToolChoiceMode = Schema.Literals(["auto", "none", "required"]);

const ToolChoice = Schema.Union([
  ToolChoiceMode,
  Schema.Struct({
    type: Schema.Literal("function"),
    function: Schema.Struct({ name: Schema.String }),
  }),
]);

const JsonSchemaFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  json_schema: Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
    schema: Schema.optionalKey(Schema.Unknown),
    strict: Schema.optionalKey(Schema.Boolean),
  }),
});

const ResponseFormat = Schema.Union([
  JsonSchemaFormat,
  Schema.Struct({ type: Schema.Literals(["json_object", "text"]) }),
]);

export const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Message),
  tools: Schema.optionalKey(Schema.Array(FunctionTool)),
  tool_choice: Schema.optionalKey(ToolChoice),
  parallel_tool_calls: Schema.optionalKey(Schema.Boolean),
  response_format: Schema.optionalKey(ResponseFormat),
  reasoning_effort: Schema.optionalKey(Schema.String),
  stream: Schema.optionalKey(Schema.Boolean),
  stream_options: Schema.optionalKey(
    Schema.Struct({ include_usage: Schema.optionalKey(Schema.Boolean) }),
  ),
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

  if (Schema.is(ToolMessage)(message)) {
    return [
      { type: "function_call_output", call_id: message.tool_call_id, output: message.content },
    ];
  }

  const text = message.content
    ? [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        },
      ]
    : [];

  const calls = (message.tool_calls ?? []).map((call) => ({
    type: "function_call",
    call_id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  }));

  return [...text, ...calls];
};

const tool = ({ function: fn }: typeof FunctionTool.Type) => ({ type: "function", ...fn });

const toolChoice = (choice: typeof ToolChoice.Type) =>
  Schema.is(ToolChoiceMode)(choice) ? choice : { type: "function", name: choice.function.name };

const textFormat = (format: typeof ResponseFormat.Type) =>
  Schema.is(JsonSchemaFormat)(format)
    ? { type: "json_schema", ...format.json_schema }
    : { type: format.type };

/** The Responses API request equivalent to a Chat Completions request. */
export const toResponsesRequest = (chat: ChatRequest): Record<string, unknown> => ({
  model: chat.model,
  instructions: chat.messages
    .filter(Schema.is(InstructionMessage))
    .map((message) => message.content)
    .join("\n\n"),
  input: chat.messages.flatMap(inputItems),
  ...(chat.tools && { tools: chat.tools.map(tool) }),
  ...(chat.tool_choice && { tool_choice: toolChoice(chat.tool_choice) }),
  ...(chat.parallel_tool_calls !== undefined && { parallel_tool_calls: chat.parallel_tool_calls }),
  ...(chat.response_format && { text: { format: textFormat(chat.response_format) } }),
  ...(chat.reasoning_effort && { reasoning: { effort: chat.reasoning_effort } }),
  ...(chat.stream !== undefined && { stream: chat.stream }),
});
