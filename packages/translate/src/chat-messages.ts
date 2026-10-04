// Chat Completions to and from Anthropic's Messages API, for a model a provider
// serves only in Messages: the request going out, and the answer coming back,
// whole or streamed.
import { streamIncomplete } from "@via/codex-upstream";
import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import type { ChatRequest } from "./chat-request.ts";

/** The output tokens asked for when the client names no limit; Messages requires one. */
export const DEFAULT_MAX_TOKENS = 32_000;

type Block = Schema.JsonObject;

type Turn = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };

const decodeArguments = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

/**
 * A data URL's media type and base64 data, if `url` is one; parameters between the two,
 * such as a file name, are skipped.
 */
const dataUrl = (url: string) => {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.*)$/s.exec(url);

  return match === null
    ? Option.none()
    : Option.some({ mediaType: match[1] ?? "", data: match[2] ?? "" });
};

const imageBlock = (url: string): Block =>
  Option.match(dataUrl(url), {
    onNone: () => ({ type: "image", source: { type: "url", url } }),
    onSome: ({ mediaType, data }) => ({
      type: "image",
      source: { type: "base64", media_type: mediaType, data },
    }),
  });

type Message = ChatRequest["messages"][number];

/** The Messages turn a chat message becomes; instructions go to `system` instead. */
const turnOf = (message: Message): Option.Option<Turn> => {
  switch (message.role) {
    case "system":
    case "developer":
      return Option.none();
    case "user":
      return Option.some({
        role: "user",
        content: (Predicate.isString(message.content)
          ? [{ type: "text", text: message.content }]
          : message.content.map((part) =>
              part.type === "text"
                ? { type: "text", text: part.text }
                : imageBlock(part.image_url.url),
            )
        ).filter((block) => block.text !== ""),
      });
    case "assistant":
      return Option.some({
        role: "assistant",
        content: [
          ...(message.content == null || message.content === ""
            ? []
            : [{ type: "text", text: message.content }]),
          ...(message.tool_calls ?? []).map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            // Arguments that aren't a JSON object, such as none at all, call the tool without any.
            input: Option.getOrElse(decodeArguments(call.function.arguments), () => ({})),
          })),
        ],
      });
    case "tool":
      return Option.some({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content },
        ],
      });
  }
};

/** Messages takes turns that alternate, so consecutive ones of a role become one. */
const alternating = (turns: ReadonlyArray<Turn>) =>
  turns.reduce<Array<Turn>>((merged, turn) => {
    const last = merged.at(-1);

    if (last !== undefined && last.role === turn.role) {
      merged[merged.length - 1] = { role: turn.role, content: [...last.content, ...turn.content] };
    } else {
      merged.push(turn);
    }

    return merged;
  }, []);

const toolChoice = (choice: NonNullable<ChatRequest["tool_choice"]>) => {
  if (choice === "auto") return { type: "auto" };

  if (choice === "none") return { type: "none" };

  if (choice === "required") return { type: "any" };

  return { type: "tool", name: choice.function.name };
};

/**
 * The Messages tool choice for `chat`: Chat's `parallel_tool_calls: false` is Messages'
 * `disable_parallel_tool_use`, which goes with any choice but none.
 */
const chosenTool = (chat: ChatRequest) => {
  const choice = chat.tool_choice === undefined ? undefined : toolChoice(chat.tool_choice);

  if (chat.parallel_tool_calls !== false || chat.tools === undefined || choice?.type === "none") {
    return choice;
  }

  return { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: true };
};

/** The Messages request equivalent to a Chat Completions one. */
export const toMessagesRequest = (chat: ChatRequest) => {
  const system = chat.messages
    .flatMap((message) =>
      message.role === "system" || message.role === "developer" ? [message.content] : [],
    )
    .join("\n\n");

  const maxTokens = chat.max_completion_tokens ?? chat.max_tokens ?? DEFAULT_MAX_TOKENS;
  const choice = chosenTool(chat);
  const stop = chat.stop ?? undefined;

  return {
    model: chat.model,
    ...(system !== "" && { system }),
    // Messages refuses a turn with nothing in it, as a chat history can hold.
    messages: alternating(
      chat.messages
        .flatMap((message) => Option.toArray(turnOf(message)))
        .filter((turn) => turn.content.length > 0),
    ),
    max_tokens: maxTokens,
    ...(chat.temperature != null && { temperature: chat.temperature }),
    ...(chat.top_p != null && { top_p: chat.top_p }),
    ...(stop !== undefined && { stop_sequences: Predicate.isString(stop) ? [stop] : stop }),
    ...(chat.tools && {
      tools: chat.tools.map(({ function: fn }) => ({
        name: fn.name,
        ...(fn.description !== undefined && { description: fn.description }),
        input_schema: fn.parameters ?? { type: "object", properties: {} },
      })),
    }),
    ...(choice !== undefined && { tool_choice: choice }),
    ...(chat.stream !== undefined && { stream: chat.stream }),
  };
};

const MessagesUsage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  cache_read_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  cache_creation_input_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  output_tokens: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});

type Counts = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly output: number;
};

const noCounts: Counts = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };

/** The counts a usage object adds to `counts`: a later one replaces what it names. */
const counted = (counts: Counts, usage: typeof MessagesUsage.Type): Counts => ({
  input: usage.input_tokens ?? counts.input,
  cacheRead: usage.cache_read_input_tokens ?? counts.cacheRead,
  cacheCreation: usage.cache_creation_input_tokens ?? counts.cacheCreation,
  output: usage.output_tokens ?? counts.output,
});

/**
 * Chat Completions usage from Messages counts. Messages counts cached input,
 * and input written to the cache, apart from input; Chat counts both as part
 * of the prompt, as via does, and the written part as OpenRouter does.
 */
const chatUsage = (counts: Counts) => {
  const prompt = counts.input + counts.cacheRead + counts.cacheCreation;

  return {
    prompt_tokens: prompt,
    completion_tokens: counts.output,
    total_tokens: prompt + counts.output,
    prompt_tokens_details: {
      cached_tokens: counts.cacheRead,
      cache_write_tokens: counts.cacheCreation,
    },
  };
};

const finishReason = (stopReason: string | null | undefined) => {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
};

const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Json,
  }),
  Schema.Struct({ type: Schema.String }),
]);

const Message = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  content: Schema.Array(ContentBlock),
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: MessagesUsage,
});

export type MessagesMessage = typeof Message.Type;

export const MessagesMessage = Message;

/** The Chat Completions answer equivalent to a Messages message, `created` in seconds. */
export const toChatCompletionFromMessage = (message: MessagesMessage, created: number) => {
  const text = message.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("");

  const reasoning = message.content
    .flatMap((block) => ("thinking" in block ? [block.thinking] : []))
    .join("");

  const calls = message.content.flatMap((block) =>
    "input" in block
      ? [
          {
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          },
        ]
      : [],
  );

  return {
    id: message.id,
    object: "chat.completion",
    created,
    model: message.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          // OpenAI answers a turn of only tool calls with no content, not an empty one.
          content: text === "" && calls.length > 0 ? null : text,
          ...(reasoning !== "" && { reasoning_content: reasoning }),
          ...(calls.length > 0 && { tool_calls: calls }),
        },
        finish_reason: finishReason(message.stop_reason),
      },
    ],
    usage: chatUsage(counted(noCounts, message.usage)),
  };
};

const MessageStart = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({ id: Schema.String, model: Schema.String, usage: MessagesUsage }),
});

const BlockStart = Schema.Struct({
  type: Schema.Literal("content_block_start"),
  index: Schema.Int,
  content_block: ContentBlock,
});

const BlockDelta = Schema.Struct({
  type: Schema.Literal("content_block_delta"),
  index: Schema.Int,
  delta: Schema.Union([
    Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
    Schema.Struct({ type: Schema.Literal("thinking_delta"), thinking: Schema.String }),
    Schema.Struct({ type: Schema.Literal("input_json_delta"), partial_json: Schema.String }),
    Schema.Struct({ type: Schema.String }),
  ]),
});

const MessageDelta = Schema.Struct({
  type: Schema.Literal("message_delta"),
  delta: Schema.Struct({ stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  usage: Schema.optionalKey(MessagesUsage),
});

const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.Struct({ type: Schema.String, message: Schema.String }),
});

// Pings and block ends have no Chat Completions counterpart.
const Other = Schema.Struct({ type: Schema.String });

const StreamEvent = Schema.Union([
  MessageStart,
  BlockStart,
  BlockDelta,
  MessageDelta,
  ErrorEvent,
  Other,
]);

type StreamEvent = typeof StreamEvent.Type;

const isMessageStart = Schema.is(MessageStart);

const isBlockStart = Schema.is(BlockStart);

const isBlockDelta = Schema.is(BlockDelta);

const isMessageDelta = Schema.is(MessageDelta);

const isError = Schema.is(ErrorEvent);

type State = {
  readonly envelope: string;
  /** The chat tool call index of each tool_use block, by Messages block index. */
  readonly toolIndex: ReadonlyMap<number, number>;
  readonly counts: Counts;
  readonly stopReason: string | null | undefined;
  /** Whether the stream reached `message_stop` or an error. */
  readonly ended: boolean;
};

/** A piece of the Chat stream, or the usage it ended with, which is reported as well as sent. */
type Out = { readonly text: string } | { readonly usage: ReturnType<typeof chatUsage> };

const envelope = (id: string, created: number, model: string) =>
  JSON.stringify({ id, object: "chat.completion.chunk", created, model }).slice(0, -1);

const chunk = (state: State, delta: Schema.JsonObject, reason: string | null = null): Out => ({
  text: `data: ${state.envelope},"choices":[{"index":0,"delta":${JSON.stringify(delta)},"finish_reason":${JSON.stringify(reason)}}]}\n\n`,
});

// Chat Completions has no failure event; clients such as the openai SDK raise
// an `error` payload sent in place of a chunk.
const failure = (type: string, message: string): Out => ({
  text: `data: ${JSON.stringify({ error: { message, type: "server_error", code: type } })}\n\n`,
});

const incomplete = failure(streamIncomplete.code, "The Messages stream broke off before it ended");

// What a stream that ends without `message_stop` was still billed for, as far as it got:
// nothing until `message_start` counted something.
const spent = (state: State): Array<Out> =>
  state.counts === noCounts ? [] : [{ usage: chatUsage(state.counts) }];

/**
 * Rewrites a Messages SSE stream into a Chat Completions SSE stream, `created`
 * in seconds. Its usage goes to `onUsage` whether or not the client asked for
 * the usage chunk. A stream that fails or breaks off ends in an error payload
 * instead of `[DONE]`.
 */
export const toChatStreamFromMessages = <E, R>(
  body: Stream.Stream<Uint8Array, E>,
  options: {
    readonly includeUsage: boolean;
    readonly created: number;
    readonly onUsage: (usage: Schema.Json) => Effect.Effect<void, never, R>;
  },
): Stream.Stream<Uint8Array, never, R> => {
  const initial = (): State => ({
    envelope: envelope("", options.created, ""),
    toolIndex: new Map(),
    counts: noCounts,
    stopReason: undefined,
    ended: false,
  });

  const step = (state: State, event: StreamEvent): readonly [State, Array<Out>] => {
    if (isMessageStart(event)) {
      const next = {
        ...state,
        envelope: envelope(event.message.id, options.created, event.message.model),
        counts: counted(state.counts, event.message.usage),
      };

      return [next, [chunk(next, { role: "assistant", content: "" })]];
    }

    if (isBlockStart(event) && "input" in event.content_block) {
      const index = state.toolIndex.size;
      const toolIndex = new Map(state.toolIndex).set(event.index, index);
      const { id, name } = event.content_block;

      return [
        { ...state, toolIndex },
        [
          chunk(state, {
            tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
          }),
        ],
      ];
    }

    if (isBlockDelta(event)) {
      const { delta } = event;

      if ("text" in delta) return [state, [chunk(state, { content: delta.text })]];

      if ("thinking" in delta)
        return [state, [chunk(state, { reasoning_content: delta.thinking })]];

      if ("partial_json" in delta) {
        const index = state.toolIndex.get(event.index);

        // Arguments for a call the client never saw announced belong to no tool call.
        if (index === undefined) return [state, []];

        return [
          state,
          [chunk(state, { tool_calls: [{ index, function: { arguments: delta.partial_json } }] })],
        ];
      }

      return [state, []];
    }

    if (isMessageDelta(event)) {
      return [
        {
          ...state,
          stopReason: event.delta.stop_reason ?? state.stopReason,
          counts: event.usage === undefined ? state.counts : counted(state.counts, event.usage),
        },
        [],
      ];
    }

    if (isError(event)) {
      return [
        { ...state, ended: true },
        [...spent(state), failure(event.error.type, event.error.message)],
      ];
    }

    if (event.type === "message_stop") {
      const usage = chatUsage(state.counts);

      return [
        { ...state, ended: true },
        [
          chunk(state, {}, finishReason(state.stopReason)),
          { usage },
          ...(options.includeUsage
            ? [
                {
                  text: `data: ${state.envelope},"choices":[],"usage":${JSON.stringify(usage)}}\n\n`,
                },
              ]
            : []),
          { text: "data: [DONE]\n\n" },
        ],
      ];
    }

    return [state, []];
  };

  return body.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    Stream.takeUntil((event) => event.type === "message_stop" || event.type === "error"),
    // A read that fails ends the stream here, so `onHalt` reports it once.
    Stream.ignore,
    Stream.mapAccum(initial, step, {
      onHalt: (state) => (state.ended ? [] : [...spent(state), incomplete]),
    }),
    Stream.mapEffect((out) =>
      "usage" in out ? Effect.as(options.onUsage(out.usage), "") : Effect.succeed(out.text),
    ),
    Stream.filter((text) => text !== ""),
    Stream.encodeText,
  );
};
