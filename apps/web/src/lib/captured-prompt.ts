/**
 * The prompt of a failed request via kept, read as a conversation: its
 * parameters, its tools, and its messages by role, each a run of text, images,
 * tool calls and their results. It reads a chat completion (`messages`) and a
 * Responses request (`instructions` and `input`); any other body is none, for
 * the page to show as JSON. A part it doesn't know stays, as its JSON.
 */
import { Array as Arr, Match, Option, Predicate, Schema } from "effect";

type Json = typeof Schema.Json.Type;

export type PromptPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly label: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "toolCall";
      readonly name: string;
      readonly id: Option.Option<string>;
      readonly arguments: string;
    }
  | { readonly kind: "toolResult"; readonly id: Option.Option<string>; readonly text: string }
  | { readonly kind: "other"; readonly json: string };

export interface PromptMessage {
  /** As the request named it: `system`, `developer`, `user`, `assistant`, `tool`, or `instructions`. */
  readonly role: string;
  readonly parts: ReadonlyArray<PromptPart>;
}

export interface Prompt {
  readonly format: "chat" | "responses";
  /** What the request asked for, beyond its messages: its model, limits and sampling. */
  readonly parameters: ReadonlyArray<readonly [string, string]>;
  /** The names of the tools it offered. */
  readonly tools: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<PromptMessage>;
}

const pretty = (json: Json) => JSON.stringify(json, null, 2);

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A tool call's arguments: pretty when they are JSON, as sent when not. */
const argumentsText = (value: Json | undefined) =>
  Predicate.isString(value)
    ? Option.match(decodeJsonText(value), {
        onNone: () => value,
        onSome: (parsed) => (Predicate.isObject(parsed) ? pretty(parsed) : value),
      })
    : value === undefined
      ? ""
      : pretty(value);

const Text = Schema.Struct({ type: Schema.optionalKey(Schema.String), text: Schema.String });

const ImageUrl = Schema.Struct({
  type: Schema.Literals(["image_url", "input_image"]),
  image_url: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Struct({ url: Schema.String })]),
  ),
});

const Refusal = Schema.Struct({ type: Schema.Literal("refusal"), refusal: Schema.String });

const decodeText = Schema.decodeUnknownOption(Text);

const decodeImage = Schema.decodeUnknownOption(ImageUrl);

const decodeRefusal = Schema.decodeUnknownOption(Refusal);

/** One part of a message's content. */
const partOf = (part: Json): PromptPart =>
  Option.firstSomeOf([
    Option.map(decodeImage(part), ({ image_url }): PromptPart => ({
      kind: "image",
      label: Predicate.isString(image_url) ? image_url : (image_url?.url ?? "Image"),
    })),
    Option.map(decodeText(part), ({ text }): PromptPart => ({ kind: "text", text })),
    Option.map(decodeRefusal(part), ({ refusal }): PromptPart => ({ kind: "text", text: refusal })),
  ]).pipe(Option.getOrElse((): PromptPart => ({ kind: "other", json: pretty(part) })));

/** A message's content, a string or a list of parts, as parts; none for null. */
const contentOf = (content: Json | undefined): ReadonlyArray<PromptPart> =>
  Predicate.isString(content)
    ? content === ""
      ? []
      : [{ kind: "text", text: content }]
    : Array.isArray(content)
      ? content.map(partOf)
      : content === null || content === undefined
        ? []
        : [partOf(content)];

/** A part of a tool's result, as text. */
const partText = Match.type<PromptPart>().pipe(
  Match.discriminatorsExhaustive("kind")({
    text: (part) => part.text,
    reasoning: (part) => part.text,
    image: (part) => part.label,
    toolCall: (part) => part.arguments,
    toolResult: (part) => part.text,
    other: (part) => part.json,
  }),
);

/** The text of a tool's result, which may come as parts. */
const resultText = (content: Json | undefined) => contentOf(content).map(partText).join("\n");

const ChatToolCall = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Json) }),
});

const decodeChatToolCall = Schema.decodeUnknownOption(ChatToolCall);

const ChatMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optionalKey(Schema.Json),
  tool_calls: Schema.optionalKey(Schema.Array(Schema.Json)),
  tool_call_id: Schema.optionalKey(Schema.String),
});

const chatMessage = (message: typeof ChatMessage.Type): PromptMessage => ({
  role: message.role,
  parts:
    message.role === "tool"
      ? [
          {
            kind: "toolResult",
            id: Option.fromNullishOr(message.tool_call_id),
            text: resultText(message.content),
          },
        ]
      : [
          ...contentOf(message.content),
          ...(message.tool_calls ?? []).map((call) =>
            Option.match(decodeChatToolCall(call), {
              onNone: (): PromptPart => ({ kind: "other", json: pretty(call) }),
              onSome: (read): PromptPart => ({
                kind: "toolCall",
                name: read.function.name,
                id: Option.fromNullishOr(read.id),
                arguments: argumentsText(read.function.arguments),
              }),
            }),
          ),
        ],
});

const Chat = Schema.Struct({ messages: Schema.Array(ChatMessage) });

const InputMessage = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("message")),
  role: Schema.String,
  content: Schema.optionalKey(Schema.Json),
});

const FunctionCall = Schema.Struct({
  type: Schema.Literals(["function_call", "custom_tool_call"]),
  call_id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
  input: Schema.optionalKey(Schema.Json),
});

const FunctionCallOutput = Schema.Struct({
  type: Schema.Literals(["function_call_output", "custom_tool_call_output"]),
  call_id: Schema.optionalKey(Schema.String),
  output: Schema.optionalKey(Schema.Json),
});

const Reasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  summary: Schema.optionalKey(Schema.Array(Schema.Json)),
});

const decodeInputMessage = Schema.decodeUnknownOption(InputMessage);

const decodeFunctionCall = Schema.decodeUnknownOption(FunctionCall);

const decodeFunctionCallOutput = Schema.decodeUnknownOption(FunctionCallOutput);

const decodeReasoning = Schema.decodeUnknownOption(Reasoning);

/** One item of a Responses request's input, as a message. */
const inputItem = (item: Json): PromptMessage =>
  Option.firstSomeOf([
    Option.map(decodeInputMessage(item), (message): PromptMessage => ({
      role: message.role,
      parts: contentOf(message.content),
    })),
    Option.map(decodeFunctionCall(item), (call): PromptMessage => ({
      role: "assistant",
      parts: [
        {
          kind: "toolCall",
          name: call.name,
          id: Option.fromNullishOr(call.call_id),
          arguments: argumentsText(call.arguments ?? call.input),
        },
      ],
    })),
    Option.map(decodeFunctionCallOutput(item), (output): PromptMessage => ({
      role: "tool",
      parts: [
        {
          kind: "toolResult",
          id: Option.fromNullishOr(output.call_id),
          text: resultText(output.output),
        },
      ],
    })),
    Option.map(decodeReasoning(item), (reasoning): PromptMessage => ({
      role: "assistant",
      parts: [
        {
          kind: "reasoning",
          text: Arr.getSomes(
            (reasoning.summary ?? []).map((part) =>
              Option.map(decodeText(part), ({ text }) => text),
            ),
          ).join("\n\n"),
        },
      ],
    })),
  ]).pipe(
    Option.getOrElse((): PromptMessage => ({
      role: "item",
      parts: [{ kind: "other", json: pretty(item) }],
    })),
  );

const Responses = Schema.Struct({
  instructions: Schema.optionalKey(Schema.String),
  input: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});

const decodeChat = Schema.decodeUnknownOption(Chat);

const decodeResponses = Schema.decodeUnknownOption(Responses);

const Parameters = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  max_tokens: Schema.optionalKey(Schema.Finite),
  max_completion_tokens: Schema.optionalKey(Schema.Finite),
  max_output_tokens: Schema.optionalKey(Schema.Finite),
  reasoning_effort: Schema.optionalKey(Schema.String),
  reasoning: Schema.optionalKey(Schema.Struct({ effort: Schema.optionalKey(Schema.String) })),
  temperature: Schema.optionalKey(Schema.Finite),
  top_p: Schema.optionalKey(Schema.Finite),
  stream: Schema.optionalKey(Schema.Boolean),
  tool_choice: Schema.optionalKey(Schema.Json),
  tools: Schema.optionalKey(Schema.Array(Schema.Json)),
});

const decodeParameters = Schema.decodeUnknownOption(Parameters);

const Tool = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  function: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
});

const decodeTool = Schema.decodeUnknownOption(Tool);

/** A tool's name: its function's, its own, or its type for a built-in one. */
const toolName = (tool: Json) =>
  Option.flatMap(decodeTool(tool), (read) =>
    Option.fromNullishOr(read.function?.name ?? read.name ?? read.type),
  );

const parametersOf = (body: Json) =>
  Option.match(decodeParameters(body), {
    onNone: () => ({ parameters: [], tools: [] }),
    onSome: (read) => {
      const maxTokens = read.max_tokens ?? read.max_completion_tokens ?? read.max_output_tokens;
      const reasoning = read.reasoning_effort ?? read.reasoning?.effort;

      const entries: ReadonlyArray<readonly [string, string | undefined]> = [
        ["Model", read.model],
        ["Max tokens", maxTokens === undefined ? undefined : String(maxTokens)],
        ["Reasoning", reasoning],
        ["Temperature", read.temperature === undefined ? undefined : String(read.temperature)],
        ["Top p", read.top_p === undefined ? undefined : String(read.top_p)],
        ["Stream", read.stream === undefined ? undefined : read.stream ? "yes" : "no"],
        [
          "Tool choice",
          read.tool_choice === undefined
            ? undefined
            : Predicate.isString(read.tool_choice)
              ? read.tool_choice
              : JSON.stringify(read.tool_choice),
        ],
      ];

      return {
        parameters: Arr.getSomes(
          entries.map(([label, value]) =>
            Option.map(Option.fromNullishOr(value), (shown) => [label, shown] as const),
          ),
        ),
        tools: Arr.getSomes((read.tools ?? []).map(toolName)),
      };
    },
  });

/** `body`, a request via kept, read as a prompt; none when it is neither shape via knows. */
export const promptOf = (body: Json): Option.Option<Prompt> =>
  Option.firstSomeOf([
    Option.map(decodeChat(body), (chat): Prompt => ({
      format: "chat",
      ...parametersOf(body),
      messages: chat.messages.map(chatMessage),
    })),
    Option.map(decodeResponses(body), (responses): Prompt => ({
      format: "responses",
      ...parametersOf(body),
      messages: [
        ...(responses.instructions === undefined || responses.instructions === ""
          ? []
          : [
              {
                role: "instructions",
                parts: [{ kind: "text", text: responses.instructions } as const],
              },
            ]),
        ...(Predicate.isString(responses.input)
          ? [{ role: "user", parts: contentOf(responses.input) }]
          : responses.input.map(inputItem)),
      ],
    })),
  ]);

export interface MarkedText {
  readonly kind: "text" | "redacted" | "image";
  readonly text: string;
}

// What via puts in a body in place of a secret, or of an image's data.
const MARKER = /\[(?:redacted:[^\]\s]+|image: [^\]]+)\]/g;

/** `text`, split into its runs of plain text and the markers via put in place of secrets and images. */
export const markersIn = (text: string): ReadonlyArray<MarkedText> => {
  const runs: Array<MarkedText> = [];
  let from = 0;

  for (const match of text.matchAll(MARKER)) {
    if (match.index > from) runs.push({ kind: "text", text: text.slice(from, match.index) });
    runs.push({ kind: match[0].startsWith("[image") ? "image" : "redacted", text: match[0] });
    from = match.index + match[0].length;
  }

  if (from < text.length) runs.push({ kind: "text", text: text.slice(from) });

  return runs;
};
