import { ResponsesUsage } from "@via/codex-upstream";
import { Schema } from "effect";

const OutputText = Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String });

const Refusal = Schema.Struct({ type: Schema.Literal("refusal"), refusal: Schema.String });

const MessageItem = Schema.Struct({
  type: Schema.Literal("message"),
  content: Schema.Array(
    Schema.Union([OutputText, Refusal, Schema.Struct({ type: Schema.String })]),
  ),
});

const FunctionCallItem = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});

const SummaryText = Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String });

const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  summary: Schema.Array(Schema.Union([SummaryText, Schema.Struct({ type: Schema.String })])),
});

// Other items have no Chat Completions counterpart.
const OtherItem = Schema.Struct({ type: Schema.String });

/** Responses usage with the total, which Chat Completions reports. */
export const Usage = Schema.Struct({ ...ResponsesUsage.fields, total_tokens: Schema.Finite });

export const CompletedResponse = Schema.Struct({
  id: Schema.String,
  created_at: Schema.Finite,
  model: Schema.String,
  output: Schema.Array(Schema.Union([MessageItem, FunctionCallItem, ReasoningItem, OtherItem])),
  // Codex may leave the usage out, or send `null`; the answer is no less complete.
  usage: Schema.optionalKey(Schema.NullOr(Usage)),
  incomplete_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reason: Schema.String }))),
});

export type CompletedResponse = typeof CompletedResponse.Type;

const isOutputText = Schema.is(OutputText);

const isRefusal = Schema.is(Refusal);

const isMessageItem = Schema.is(MessageItem);

const isFunctionCallItem = Schema.is(FunctionCallItem);

const isReasoningItem = Schema.is(ReasoningItem);

const isSummaryText = Schema.is(SummaryText);

/** Token usage in Chat Completions terms, with only the details Codex reported. */
export const chatUsage = (usage: typeof Usage.Type) => {
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;

  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(cached !== undefined && { prompt_tokens_details: { cached_tokens: cached } }),
    ...(reasoning !== undefined && {
      completion_tokens_details: { reasoning_tokens: reasoning },
    }),
  };
};

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
  const parts = response.output.filter(isMessageItem).flatMap((item) => item.content);

  const text = parts
    .filter(isOutputText)
    .map((part) => part.text)
    .join("");

  const refusal = parts
    .filter(isRefusal)
    .map((part) => part.refusal)
    .join("");

  // Each summary part reads as a paragraph, as `toChatStream` streams them.
  const reasoning = response.output
    .filter(isReasoningItem)
    .flatMap((item) => item.summary)
    .filter(isSummaryText)
    .map((part) => part.text)
    .filter((paragraph) => paragraph !== "")
    .join("\n\n");

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
          // A refusal, like a tool call, answers in place of content.
          content: text === "" && (toolCalls.length > 0 || refusal !== "") ? null : text,
          ...(reasoning !== "" && { reasoning_content: reasoning }),
          ...(refusal !== "" && { refusal }),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: finishReason(response.incomplete_details, toolCalls.length > 0),
      },
    ],
    ...(response.usage != null && { usage: chatUsage(response.usage) }),
  };
};
