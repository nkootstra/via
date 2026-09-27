import { Schema } from "effect";

const OutputText = Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String });

const MessageItem = Schema.Struct({
  type: Schema.Literal("message"),
  content: Schema.Array(Schema.Union([OutputText, Schema.Struct({ type: Schema.String })])),
});

const FunctionCallItem = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});

// Reasoning and other items have no Chat Completions counterpart.
const OtherItem = Schema.Struct({ type: Schema.String });

export const Usage = Schema.Struct({
  input_tokens: Schema.Finite,
  output_tokens: Schema.Finite,
  total_tokens: Schema.Finite,
});

export const CompletedResponse = Schema.Struct({
  id: Schema.String,
  created_at: Schema.Finite,
  model: Schema.String,
  output: Schema.Array(Schema.Union([MessageItem, FunctionCallItem, OtherItem])),
  usage: Usage,
  incomplete_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
});

export type CompletedResponse = typeof CompletedResponse.Type;

/** Token usage in Chat Completions terms. */
export const chatUsage = (usage: typeof Usage.Type) => ({
  prompt_tokens: usage.input_tokens,
  completion_tokens: usage.output_tokens,
  total_tokens: usage.total_tokens,
});

/** Why Chat Completions says a response stopped short, by Responses incomplete reason. */
export const incompleteFinish = (reason: string) =>
  reason === "content_filter" ? reason : "length";

/** The Chat Completions answer equivalent to a completed Responses response. */
export const toChatCompletion = (response: CompletedResponse) => {
  const text = response.output
    .filter(Schema.is(MessageItem))
    .flatMap((item) => item.content.filter(Schema.is(OutputText)))
    .map((part) => part.text)
    .join("");

  const toolCalls = response.output.filter(Schema.is(FunctionCallItem)).map((call) => ({
    id: call.call_id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text === "" && toolCalls.length > 0 ? null : text,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason:
          response.incomplete_details != null
            ? incompleteFinish(response.incomplete_details.reason)
            : toolCalls.length > 0
              ? "tool_calls"
              : "stop",
      },
    ],
    usage: chatUsage(response.usage),
  };
};
