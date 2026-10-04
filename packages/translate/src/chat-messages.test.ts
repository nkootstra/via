import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { ChatRequest } from "./chat-request.ts";
import {
  DEFAULT_MAX_TOKENS,
  toChatCompletionFromMessage,
  toChatStreamFromMessages,
  toMessagesRequest,
} from "./chat-messages.ts";

const chat = (fields: Schema.JsonObject) =>
  Schema.decodeUnknownSync(ChatRequest)({ model: "minimax-m2.7", messages: [], ...fields });

describe("toMessagesRequest", () => {
  it("moves system messages to `system`, and asks for as many tokens as the client allows", () => {
    expect(
      toMessagesRequest(
        chat({
          max_tokens: 500,
          temperature: 0.2,
          stop: ["END"],
          messages: [
            { role: "system", content: "Be brief." },
            { role: "developer", content: "Use British spelling." },
            { role: "user", content: "hi" },
          ],
        }),
      ),
    ).toEqual({
      model: "minimax-m2.7",
      system: "Be brief.\n\nUse British spelling.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      max_tokens: 500,
      temperature: 0.2,
      stop_sequences: ["END"],
    });
  });

  it("asks for a default number of tokens when the client names none", () => {
    expect(toMessagesRequest(chat({ messages: [{ role: "user", content: "hi" }] }))).toMatchObject({
      max_tokens: DEFAULT_MAX_TOKENS,
    });
  });

  it("turns tool calls into tool_use blocks, and tool answers into one user turn of results", () => {
    const request = toMessagesRequest(
      chat({
        messages: [
          { role: "user", content: "list files" },
          {
            role: "assistant",
            content: "Let me look.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "ls", arguments: '{"path":"."}' },
              },
              { id: "call_2", type: "function", function: { name: "pwd", arguments: "" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "a.txt" },
          { role: "tool", tool_call_id: "call_2", content: "/tmp" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "ls", description: "List", parameters: { type: "object" } },
          },
        ],
        tool_choice: "required",
      }),
    );

    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "list files" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "call_1", name: "ls", input: { path: "." } },
          { type: "tool_use", id: "call_2", name: "pwd", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "a.txt" },
          { type: "tool_result", tool_use_id: "call_2", content: "/tmp" },
        ],
      },
    ]);

    expect(request.tools).toEqual([
      { name: "ls", description: "List", input_schema: { type: "object" } },
    ]);
    expect(request.tool_choice).toEqual({ type: "any" });
  });

  it("asks for one tool call at a time when the client turns parallel calls off", () => {
    const tools = [{ type: "function", function: { name: "ls" } }];

    const forced = toMessagesRequest(
      chat({ messages: [], tools, tool_choice: "required", parallel_tool_calls: false }),
    );

    expect(forced.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true });

    const unforced = toMessagesRequest(chat({ messages: [], tools, parallel_tool_calls: false }));
    expect(unforced.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });

    const none = toMessagesRequest(
      chat({ messages: [], tools, tool_choice: "none", parallel_tool_calls: false }),
    );

    expect(none.tool_choice).toEqual({ type: "none" });
    expect(toMessagesRequest(chat({ messages: [], tools })).tool_choice).toBeUndefined();
  });

  it("sends an image by URL, or by its data when the URL carries it", () => {
    const request = toMessagesRequest(
      chat({
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://example.com/a.png" } },
              { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } },
            ],
          },
        ],
      }),
    );

    expect(request.messages[0]?.content).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
    ]);
  });
});

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "minimax-m2.7",
  content: [
    { type: "thinking", thinking: "User wants ok.", signature: "sig" },
    { type: "text", text: "ok" },
    { type: "tool_use", id: "toolu_1", name: "ls", input: { path: "." } },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, cache_read_input_tokens: 30, output_tokens: 5 },
};

describe("toChatCompletionFromMessage", () => {
  it("reads text, reasoning and tool calls, and counts cached input as input", () => {
    expect(toChatCompletionFromMessage(message, 1_700_000_000)).toEqual({
      id: "msg_1",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "minimax-m2.7",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
            reasoning_content: "User wants ok.",
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: { name: "ls", arguments: '{"path":"."}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 40,
        completion_tokens: 5,
        total_tokens: 45,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 0 },
      },
    });
  });

  it("counts input written to the cache as input, and says how much it was", () => {
    const written = {
      ...message,
      usage: { ...message.usage, cache_creation_input_tokens: 20 },
    };

    expect(toChatCompletionFromMessage(written, 1_700_000_000).usage).toEqual({
      prompt_tokens: 60,
      completion_tokens: 5,
      total_tokens: 65,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
    });
  });
});

const events = (list: ReadonlyArray<object>) =>
  Stream.make(
    new TextEncoder().encode(
      list
        .map(
          (event) =>
            `event: ${String("type" in event ? event.type : "")}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    ),
  );

const streamed = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "minimax-m2.7",
      usage: { input_tokens: 10, cache_read_input_tokens: 30, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "o" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "k" } },
  { type: "content_block_stop", index: 1 },
  {
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "toolu_1", name: "ls", input: {} },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"path":' },
  },
  {
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '"."}' },
  },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
  { type: "message_stop" },
];

const chunks = (text: string) =>
  text
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));

describe("toChatStreamFromMessages", () => {
  it.effect("streams text, reasoning and tool calls as Chat chunks, then usage and [DONE]", () =>
    Effect.gen(function* () {
      const reported: Array<unknown> = [];

      const text = yield* toChatStreamFromMessages(events(streamed), {
        includeUsage: true,
        created: 1_700_000_000,
        onUsage: (usage) => Effect.sync(() => reported.push(usage)),
      }).pipe(Stream.decodeText, Stream.mkString);

      const deltas = chunks(text).map((chunk) => chunk.choices[0]?.delta);

      expect(deltas).toEqual([
        { role: "assistant", content: "" },
        { reasoning_content: "Hmm." },
        { content: "o" },
        { content: "k" },
        {
          tool_calls: [
            { index: 0, id: "toolu_1", type: "function", function: { name: "ls", arguments: "" } },
          ],
        },
        { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '"."}' } }] },
        {},
        undefined,
      ]);

      const last = chunks(text);
      expect(last.at(-2)?.choices[0]?.finish_reason).toBe("tool_calls");

      const usage = {
        prompt_tokens: 40,
        completion_tokens: 5,
        total_tokens: 45,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 0 },
      };

      expect(last.at(-1)?.usage).toEqual(usage);
      expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
      expect(reported).toEqual([usage]);
    }),
  );

  it.effect("reports usage but sends no usage chunk to a client that didn't ask for one", () =>
    Effect.gen(function* () {
      const reported: Array<unknown> = [];

      const text = yield* toChatStreamFromMessages(events(streamed), {
        includeUsage: false,
        created: 1,
        onUsage: (usage) => Effect.sync(() => reported.push(usage)),
      }).pipe(Stream.decodeText, Stream.mkString);

      expect(text).not.toContain('"usage"');
      expect(reported).toHaveLength(1);
    }),
  );

  it.effect("ends in an error payload, not [DONE], when the stream breaks off or fails", () =>
    Effect.gen(function* () {
      const broken = yield* toChatStreamFromMessages(events(streamed.slice(0, 6)), {
        includeUsage: false,
        created: 1,
        onUsage: () => Effect.void,
      }).pipe(Stream.decodeText, Stream.mkString);

      expect(broken).toContain('"error"');
      expect(broken).not.toContain("[DONE]");

      const failed = yield* toChatStreamFromMessages(
        events([
          ...streamed.slice(0, 2),
          { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
        ]),
        { includeUsage: false, created: 1, onUsage: () => Effect.void },
      ).pipe(Stream.decodeText, Stream.mkString);

      expect(failed).toContain("Overloaded");
      expect(failed).not.toContain("[DONE]");
    }),
  );

  it.effect("reports the usage counted so far when the stream fails or breaks off", () =>
    Effect.gen(function* () {
      for (const ending of [
        [{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }],
        [],
      ]) {
        const reported: Array<unknown> = [];

        yield* toChatStreamFromMessages(events([...streamed.slice(0, 2), ...ending]), {
          includeUsage: false,
          created: 1,
          onUsage: (usage) => Effect.sync(() => reported.push(usage)),
        }).pipe(Stream.runDrain);

        expect(reported).toEqual([expect.objectContaining({ prompt_tokens: 40 })]);
      }
    }),
  );

  it.effect("ends a stream cut off before completing with an upstream_incomplete error", () =>
    Effect.gen(function* () {
      const text = yield* toChatStreamFromMessages(events(streamed.slice(0, 6)), {
        includeUsage: false,
        created: 1,
        onUsage: () => Effect.void,
      }).pipe(Stream.decodeText, Stream.mkString);

      expect(text).not.toContain("[DONE]");
      expect(chunks(text).at(-1)).toMatchObject({
        error: { type: "server_error", code: "upstream_incomplete" },
      });
    }),
  );
});
