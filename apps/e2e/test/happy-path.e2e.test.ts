import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { openai, startCodex, withVia, type Via } from "./harness.ts";

// Everything that should just work: both endpoints, streaming and not, tool
// calls, usage accounting, model listing, and the upstream shape via forwards.

/** POSTs one JSON body to via and returns the raw `Response`. */
const post = (via: Via, path: string, body: unknown) =>
  Effect.promise(() =>
    fetch(`${via.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${via.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const postJson = (via: Via, path: string, body: unknown) =>
  post(via, path, body).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())));

const postText = (via: Via, path: string, body: unknown) =>
  post(via, path, body).pipe(Effect.flatMap((response) => Effect.promise(() => response.text())));

/** Chat Completions SSE: `data: <json>\n\n` blocks, last one literally `[DONE]`. */
const parseChatSse = (text: string): ReadonlyArray<string> =>
  text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => block.replace(/^data: /, ""));

/** Responses API SSE: `event: <name>\ndata: <json>\n\n` blocks, no trailing `[DONE]`. */
type SseEvent = { readonly event: string; readonly data: string };
const parseResponsesSse = (text: string): ReadonlyArray<SseEvent> =>
  text
    .split("\n\n")
    .filter((block) => block.length > 0)
    .map((block) => {
      const [eventLine = "", dataLine = ""] = block.split("\n");
      return { event: eventLine.replace(/^event: /, ""), data: dataLine.replace(/^data: /, "") };
    });

type ChatChunk = {
  choices: ReadonlyArray<{
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
};

layer(BunFileSystem.layer)("happy path", (it) => {
  it.effect("answers a non-streaming chat completion with usage and finish_reason", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("hello there"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const completion = yield* Effect.promise(() =>
            openai(via).chat.completions.create({
              model: "gpt-6-astra",
              messages: [{ role: "user", content: "say hi" }],
            }),
          );
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
    }),
  );

  it.effect("streams a chat completion as raw SSE chunks ending in [DONE]", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("abcdef"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const response = yield* post(via, "/v1/chat/completions", {
            model: "gpt-6-astra",
            messages: [{ role: "user", content: "stream please" }],
            stream: true,
          });
          expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
          const text = yield* Effect.promise(() => response.text());
          const blocks = parseChatSse(text);
          expect(blocks.at(-1)).toBe("[DONE]");
          const chunks = blocks.slice(0, -1).map((block) => JSON.parse(block) as ChatChunk);
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
    }),
  );

  it.effect("streams a chat completion via the openai SDK", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("sdk chunks"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
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
    }),
  );

  it.effect("adds a trailing usage chunk when stream_options.include_usage is set", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("ok"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const text = yield* postText(via, "/v1/chat/completions", {
            model: "gpt-6-astra",
            messages: [{ role: "user", content: "usage please" }],
            stream: true,
            stream_options: { include_usage: true },
          });
          const blocks = parseChatSse(text);
          expect(blocks.at(-1)).toBe("[DONE]");
          const usageChunk = JSON.parse(blocks.at(-2) ?? "{}") as {
            choices: ReadonlyArray<unknown>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };
          expect(usageChunk.choices).toEqual([]);
          expect(usageChunk.usage).toEqual({
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          });
        }),
      );
    }),
  );

  it.effect("returns tool_calls with id, name, and arguments from a chat completion", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.toolCall("get_weather", { city: "oslo" }));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const body = (yield* postJson(via, "/v1/chat/completions", {
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
          })) as {
            choices: ReadonlyArray<{
              message: {
                content: string | null;
                tool_calls?: ReadonlyArray<{
                  id: string;
                  type: string;
                  function: { name: string; arguments: string };
                }>;
              };
              finish_reason: string;
            }>;
          };
          expect(body.choices[0]?.message.content).toBeNull();
          expect(body.choices[0]?.finish_reason).toBe("tool_calls");
          expect(body.choices[0]?.message.tool_calls?.[0]).toEqual({
            id: "call_fake",
            type: "function",
            function: { name: "get_weather", arguments: JSON.stringify({ city: "oslo" }) },
          });
        }),
      );
    }),
  );

  it.effect("continues a tool call across turns using a tool result message", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(
        reply.toolCall("get_weather", { city: "berlin" }),
        reply.text("sunny and 21c in berlin"),
      );
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const first = (yield* postJson(via, "/v1/chat/completions", {
            model: "gpt-6-astra",
            messages: [{ role: "user", content: "what's the weather in berlin?" }],
          })) as {
            choices: ReadonlyArray<{
              message: {
                tool_calls?: ReadonlyArray<{ id: string; function: { name: string } }>;
              };
            }>;
          };
          const call = first.choices[0]?.message.tool_calls?.[0];
          expect(call).toMatchObject({ id: "call_fake", function: { name: "get_weather" } });

          const second = (yield* postJson(via, "/v1/chat/completions", {
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
          })) as { choices: ReadonlyArray<{ message: { content: string | null } }> };
          expect(second.choices[0]?.message.content).toBe("sunny and 21c in berlin");
          expect(upstream.requests[1]?.body["input"]).toEqual(
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
    }),
  );

  it.effect("returns output_text for a non-streaming responses request", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("responses pong"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            openai(via).responses.create({ model: "gpt-6-astra", input: "responses ping" }),
          );
          expect(response.output_text).toBe("responses pong");
          expect(response.model).toBe("gpt-6-astra");
        }),
      );
    }),
  );

  it.effect("streams responses API events as raw SSE with no trailing [DONE]", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("streamed text"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const response = yield* post(via, "/v1/responses", {
            model: "gpt-6-astra",
            input: "responses stream",
            stream: true,
          });
          expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
          const text = yield* Effect.promise(() => response.text());
          expect(text).not.toContain("[DONE]");
          const events = parseResponsesSse(text);
          expect(events[0]?.event).toBe("response.created");
          expect(events.at(-1)?.event).toBe("response.completed");
          const delta = events
            .filter((event) => event.event === "response.output_text.delta")
            .map((event) => (JSON.parse(event.data) as { delta: string }).delta)
            .join("");
          expect(delta).toBe("streamed text");
        }),
      );
    }),
  );

  it.effect("returns a function_call output item from the responses API", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.toolCall("get_time", { tz: "Asia/Tokyo" }));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const body = (yield* postJson(via, "/v1/responses", {
            model: "gpt-6-astra",
            input: "please tell me the time in tokyo",
            tools: [
              {
                type: "function",
                name: "get_time",
                parameters: { type: "object", properties: { tz: { type: "string" } } },
              },
            ],
          })) as {
            output: ReadonlyArray<{
              type: string;
              call_id?: string;
              name?: string;
              arguments?: string;
            }>;
          };
          const call = body.output.find((item) => item.type === "function_call");
          expect(call).toMatchObject({
            call_id: "call_fake",
            name: "get_time",
            arguments: JSON.stringify({ tz: "Asia/Tokyo" }),
          });
        }),
      );
    }),
  );

  it.effect(
    "sends the system message as instructions and resolves the gpt-6-astra-high effort alias",
    () =>
      Effect.gen(function* () {
        const upstream = yield* startCodex;
        upstream.script(reply.text("ok"));
        yield* withVia({ upstream: upstream.url }, (via) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              openai(via).chat.completions.create({
                model: "gpt-6-astra-high",
                messages: [
                  { role: "system", content: "You are terse." },
                  { role: "user", content: "effort check" },
                ],
              }),
            );
            expect(upstream.requests[0]).toMatchObject({
              body: {
                instructions: "You are terse.",
                model: "gpt-6-astra",
                reasoning: { effort: "high" },
              },
            });
          }),
        );
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
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => openai(via).models.list());
          expect(response.data.map((model) => model.id)).toEqual([
            "gpt-7",
            "gpt-7-low",
            "gpt-7-high",
          ]);
          yield* Effect.promise(() =>
            openai(via).chat.completions.create({
              model: "gpt-7-high",
              messages: [{ role: "user", content: "ping" }],
            }),
          );
          expect(upstream.requests.at(-1)?.body).toMatchObject({
            model: "gpt-7",
            reasoning: { effort: "high" },
          });
        }),
      );
    }),
  );

  it.effect("lists the bundled models when Codex does not list any", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() => openai(via).models.list());
          const ids = response.data.map((model) => model.id);
          expect(ids).toContain("gpt-6-astra");
          expect(ids).toContain("gpt-6-astra-high");
        }),
      );
    }),
  );

  it.effect("sends session_id, an SSE accept header, and the Codex originator upstream", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("pong"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            openai(via).chat.completions.create({
              model: "gpt-6-astra",
              messages: [{ role: "user", content: "ping" }],
            }),
          );
          expect(upstream.requests[0]).toMatchObject({
            headers: {
              // Derived from the conversation's opening, as the client sent no session.
              session_id: expect.stringMatching(/^[0-9a-f]{64}$/),
              accept: "text/event-stream",
              originator: "codex-tui",
            },
          });
        }),
      );
    }),
  );
});
