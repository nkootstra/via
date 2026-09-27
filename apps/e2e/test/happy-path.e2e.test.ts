import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply, sseFrames } from "@via/codex-upstream/testing";
import { Effect, Schema } from "effect";
import {
  chat,
  decodeJson,
  json,
  launchVia,
  openai,
  post,
  responsesOf,
  startCodex,
  type Via,
} from "./harness.ts";

// Everything that should just work: both endpoints, streaming and not, tool
// calls, usage accounting, model listing, and the upstream shape via forwards.

/** POSTs one JSON body to via and decodes its JSON answer with `schema`. */
const postJson = <S extends Schema.ConstraintDecoder<unknown>>(
  via: Via,
  path: string,
  body: Schema.JsonObject,
  schema: S,
) =>
  post(via, path, body).pipe(
    Effect.flatMap(json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    // Test boundary: an answer that doesn't decode fails the test.
    Effect.orDie,
  );

const postText = (via: Via, path: string, body: Schema.JsonObject) =>
  post(via, path, body).pipe(Effect.flatMap((response) => Effect.promise(() => response.text())));

/** Chat Completions SSE: the `data` of each block, the last one literally `[DONE]`. */
const chatData = (text: string) => sseFrames(text).map((frame) => frame.data);

const ChatChunk = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      delta: Schema.Struct({
        role: Schema.optional(Schema.String),
        content: Schema.optional(Schema.String),
      }),
      finish_reason: Schema.NullOr(Schema.String),
    }),
  ),
});

layer(BunFileSystem.layer)("happy path", (it) => {
  it.effect("answers a non-streaming chat completion with usage and finish_reason", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("hello there"));
      const via = yield* launchVia({ upstream: upstream.url });

      const completion = yield* chat(via, "say hi");

      expect(completion.object).toBe("chat.completion");
      expect(completion.model).toBe("gpt-6-astra");
      expect(completion.choices[0]?.message).toMatchObject({
        role: "assistant",
        content: "hello there",
      });
      expect(completion.choices[0]?.finish_reason).toBe("stop");
      // The fake reports 10 input, 2 output, 12 total tokens.
      expect(completion.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      });
    }),
  );

  it.effect("streams a chat completion as raw SSE chunks ending in [DONE]", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("abcdef"));
      const via = yield* launchVia({ upstream: upstream.url });

      const response = yield* post(via, "/v1/chat/completions", {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "stream please" }],
        stream: true,
      });

      expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const text = yield* Effect.promise(() => response.text());
      const blocks = chatData(text);
      expect(blocks.at(-1)).toBe("[DONE]");
      const chunks = blocks.slice(0, -1).map((block) => decodeJson(ChatChunk)(block));
      expect(chunks[0]?.choices[0]).toMatchObject({
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      });
      const content = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("");
      expect(content).toBe("abcdef");
      const finishChunk = chunks.find((chunk) => chunk.choices[0]?.finish_reason !== null);
      expect(finishChunk?.choices[0]?.finish_reason).toBe("stop");
    }),
  );

  it.effect("streams a chat completion via the openai SDK", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("sdk chunks"));
      const via = yield* launchVia({ upstream: upstream.url });

      const stream = yield* Effect.promise(() =>
        openai(via).chat.completions.create({
          model: "gpt-6-astra",
          messages: [{ role: "user", content: "sdk stream" }],
          stream: true,
        }),
      );

      const result = yield* Effect.promise(async () => {
        let content = "";
        let finishReason: string | null = null;

        for await (const chunk of stream) {
          content += chunk.choices[0]?.delta.content ?? "";
          const reason = chunk.choices[0]?.finish_reason;

          if (reason) finishReason = reason;
        }

        return { content, finishReason };
      });

      expect(result.content).toBe("sdk chunks");
      expect(result.finishReason).toBe("stop");
    }),
  );

  it.effect("adds a trailing usage chunk when stream_options.include_usage is set", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("ok"));
      const via = yield* launchVia({ upstream: upstream.url });

      const text = yield* postText(via, "/v1/chat/completions", {
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "usage please" }],
        stream: true,
        stream_options: { include_usage: true },
      });

      const blocks = chatData(text);
      expect(blocks.at(-1)).toBe("[DONE]");

      const usageChunk = decodeJson(
        Schema.Struct({
          choices: Schema.Array(Schema.Unknown),
          usage: Schema.optional(
            Schema.Struct({
              prompt_tokens: Schema.Finite,
              completion_tokens: Schema.Finite,
              total_tokens: Schema.Finite,
            }),
          ),
        }),
      )(blocks.at(-2) ?? "{}");

      expect(usageChunk.choices).toEqual([]);
      expect(usageChunk.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      });
    }),
  );

  it.effect("returns tool_calls with id, name, and arguments from a chat completion", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.toolCall("get_weather", { city: "oslo" }));
      const via = yield* launchVia({ upstream: upstream.url });

      const body = yield* postJson(
        via,
        "/v1/chat/completions",
        {
          model: "gpt-6-astra",
          messages: [{ role: "user", content: "weather in oslo, please" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            },
          ],
        },
        Schema.Struct({
          choices: Schema.Array(
            Schema.Struct({
              message: Schema.Struct({
                content: Schema.NullOr(Schema.String),
                tool_calls: Schema.optional(
                  Schema.Array(
                    Schema.Struct({
                      id: Schema.String,
                      type: Schema.String,
                      function: Schema.Struct({
                        name: Schema.String,
                        arguments: Schema.String,
                      }),
                    }),
                  ),
                ),
              }),
              finish_reason: Schema.String,
            }),
          ),
        }),
      );

      expect(body.choices[0]?.message.content).toBeNull();
      expect(body.choices[0]?.finish_reason).toBe("tool_calls");
      expect(body.choices[0]?.message.tool_calls?.[0]).toEqual({
        id: "call_fake",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "oslo" }) },
      });
    }),
  );

  it.effect("continues a tool call across turns using a tool result message", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(
        reply.toolCall("get_weather", { city: "berlin" }),
        reply.text("sunny and 21c in berlin"),
      );
      const via = yield* launchVia({ upstream: upstream.url });

      const first = yield* postJson(
        via,
        "/v1/chat/completions",
        {
          model: "gpt-6-astra",
          messages: [{ role: "user", content: "what's the weather in berlin?" }],
        },
        Schema.Struct({
          choices: Schema.Array(
            Schema.Struct({
              message: Schema.Struct({
                tool_calls: Schema.optional(
                  Schema.Array(
                    Schema.Struct({
                      id: Schema.String,
                      function: Schema.Struct({ name: Schema.String }),
                    }),
                  ),
                ),
              }),
            }),
          ),
        }),
      );

      const call = first.choices[0]?.message.tool_calls?.[0];
      expect(call).toMatchObject({ id: "call_fake", function: { name: "get_weather" } });

      const second = yield* postJson(
        via,
        "/v1/chat/completions",
        {
          model: "gpt-6-astra",
          messages: [
            { role: "user", content: "what's the weather in berlin?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_fake",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: JSON.stringify({ city: "berlin" }),
                  },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_fake", content: "raw sensor reading" },
          ],
        },
        Schema.Struct({
          choices: Schema.Array(
            Schema.Struct({
              message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
            }),
          ),
        }),
      );

      expect(second.choices[0]?.message.content).toBe("sunny and 21c in berlin");
      expect(responsesOf(upstream)[1]?.body["input"]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call",
            call_id: "call_fake",
            name: "get_weather",
          }),
          {
            type: "function_call_output",
            call_id: "call_fake",
            output: "raw sensor reading",
          },
        ]),
      );
    }),
  );

  it.effect("returns output_text for a non-streaming responses request", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("responses pong"));
      const via = yield* launchVia({ upstream: upstream.url });

      const response = yield* Effect.promise(() =>
        openai(via).responses.create({ model: "gpt-6-astra", input: "responses ping" }),
      );

      expect(response.output_text).toBe("responses pong");
      expect(response.model).toBe("gpt-6-astra");
    }),
  );

  it.effect("streams responses API events as raw SSE with no trailing [DONE]", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("streamed text"));
      const via = yield* launchVia({ upstream: upstream.url });

      const response = yield* post(via, "/v1/responses", {
        model: "gpt-6-astra",
        input: "responses stream",
        stream: true,
      });

      expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const text = yield* Effect.promise(() => response.text());
      expect(text).not.toContain("[DONE]");
      const events = sseFrames(text);
      expect(events[0]?.event).toBe("response.created");
      expect(events.at(-1)?.event).toBe("response.completed");

      const delta = events
        .filter((event) => event.event === "response.output_text.delta")
        .map((event) => decodeJson(Schema.Struct({ delta: Schema.String }))(event.data).delta)
        .join("");

      expect(delta).toBe("streamed text");
    }),
  );

  it.effect("returns a function_call output item from the responses API", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.toolCall("get_time", { tz: "Asia/Tokyo" }));
      const via = yield* launchVia({ upstream: upstream.url });

      const body = yield* postJson(
        via,
        "/v1/responses",
        {
          model: "gpt-6-astra",
          input: "please tell me the time in tokyo",
          tools: [
            {
              type: "function",
              name: "get_time",
              parameters: { type: "object", properties: { tz: { type: "string" } } },
            },
          ],
        },
        Schema.Struct({
          output: Schema.Array(
            Schema.Struct({
              type: Schema.String,
              call_id: Schema.optional(Schema.String),
              name: Schema.optional(Schema.String),
              arguments: Schema.optional(Schema.String),
            }),
          ),
        }),
      );

      const call = body.output.find((item) => item.type === "function_call");
      expect(call).toMatchObject({
        call_id: "call_fake",
        name: "get_time",
        arguments: JSON.stringify({ tz: "Asia/Tokyo" }),
      });
    }),
  );

  it.effect(
    "sends the system message as instructions and resolves the gpt-6-astra-high effort alias",
    () =>
      Effect.gen(function* () {
        const upstream = yield* startCodex;
        upstream.script(reply.text("ok"));
        const via = yield* launchVia({ upstream: upstream.url });
        yield* Effect.promise(() =>
          openai(via).chat.completions.create({
            model: "gpt-6-astra-high",
            messages: [
              { role: "system", content: "You are terse." },
              { role: "user", content: "effort check" },
            ],
          }),
        );
        expect(responsesOf(upstream)[0]).toMatchObject({
          body: {
            instructions: "You are terse.",
            model: "gpt-6-astra",
            reasoning: { effort: "high" },
          },
        });
      }),
  );

  it.effect("proxies the model catalog Codex offers, and routes its effort aliases", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.models({
        models: [
          {
            slug: "gpt-7",
            display_name: "GPT-7",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
          },
          { slug: "codex-internal", visibility: "hide", supported_reasoning_levels: [] },
        ],
      });
      upstream.script(reply.text("pong"));
      const via = yield* launchVia({ upstream: upstream.url });
      const response = yield* Effect.promise(() => openai(via).models.list());
      expect(response.data.map((model) => model.id)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
      yield* Effect.promise(() =>
        openai(via).chat.completions.create({
          model: "gpt-7-high",
          messages: [{ role: "user", content: "ping" }],
        }),
      );
      expect(responsesOf(upstream).at(-1)?.body).toMatchObject({
        model: "gpt-7",
        reasoning: { effort: "high" },
      });
    }),
  );

  it.effect("lists the bundled models when Codex does not list any", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      const via = yield* launchVia({ upstream: upstream.url });
      const response = yield* Effect.promise(() => openai(via).models.list());
      const ids = response.data.map((model) => model.id);
      expect(ids).toContain("gpt-6-astra");
      expect(ids).toContain("gpt-6-astra-high");
    }),
  );

  it.effect("sends session_id, an SSE accept header, and the Codex originator upstream", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("pong"));
      const via = yield* launchVia({ upstream: upstream.url });
      yield* chat(via, "ping");
      expect(responsesOf(upstream)[0]).toMatchObject({
        headers: {
          // Derived from the conversation's opening, as the client sent no session.
          session_id: expect.stringMatching(/^[0-9a-f]{64}$/),
          accept: "text/event-stream",
          originator: "codex-tui",
        },
      });
    }),
  );
});
