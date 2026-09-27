import { ResponsesUsage } from "@via/codex-upstream";
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

/** Responses usage with the total, which Chat Completions reports. */
export const Usage = Schema.Struct({ ...ResponsesUsage.fields, total_tokens: Schema.Finite });

export const CompletedResponse = Schema.Struct({
  id: Schema.String,
  created_at: Schema.Finite,
  model: Schema.String,
  output: Schema.Array(Schema.Union([MessageItem, FunctionCallItem, OtherItem])),
  usage: Usage,
  incomplete_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
});

export type CompletedResponse = typeof CompletedResponse.Type;

const isOutputText = Schema.is(OutputText);

const isMessageItem = Schema.is(MessageItem);

const isFunctionCallItem = Schema.is(FunctionCallItem);

/** Token usage in Chat Completions terms. */
export const chatUsage = (usage: typeof Usage.Type) => ({
  prompt_tokens: usage.input_tokens,
  completion_tokens: usage.output_tokens,
  total_tokens: usage.total_tokens,
});

/**
 * Why a chat choice finished: the reason a response stopped short, if it did,
 * else whether it ended by calling tools.
 */
export const finishReason = (
  incomplete: { readonly reason: string } | null | undefined,
  calledTools: boolean,
) => {
  if (incomplete != null)
    return incomplete.reason === "content_filter" ? "content_filter" : "length";

  return calledTools ? "tool_calls" : "stop";
};

/** The Chat Completions tool call for a Responses function call. */
export const toolCall = (id: string, name: string, args: string) => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

/** The Chat Completions answer equivalent to a completed Responses response. */
export const toChatCompletion = (response: CompletedResponse) => {
  const text = response.output
    .filter(isMessageItem)
    .flatMap((item) => item.content.filter(isOutputText))
    .map((part) => part.text)
    .join("");

  const toolCalls = response.output
    .filter(isFunctionCallItem)
    .map((call) => toolCall(call.call_id, call.name, call.arguments));

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
        finish_reason: finishReason(response.incomplete_details, toolCalls.length > 0),
      },
    ],
    usage: chatUsage(response.usage),
  };
};
