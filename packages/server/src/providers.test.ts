import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply } from "@via/providers/testing";
import { Effect } from "effect";
import { ok, outwait, withVia } from "./testing/harness.ts";

const completion = { id: "chatcmpl-or", object: "chat.completion", choices: [] };

layer(BunFileSystem.layer)("OpenAI-compatible providers", (it) => {
  it.effect("forwards a chat completion for a provider's model untranslated", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json(completion));

        const response = yield* via.post("/v1/chat/completions", {
          model: "openrouter/qwen/qwen3",
          temperature: 0.3,
          messages: [{ role: "user", content: "hi" }],
        });

        expect(response.status).toBe(200);
        expect(yield* response.json).toEqual(completion);
        expect(via.provider.requests).toEqual([
          expect.objectContaining({
            path: "/chat/completions",
            headers: expect.objectContaining({ authorization: "Bearer sk-provider" }),
            body: expect.objectContaining({
              model: "qwen/qwen3",
              temperature: 0.3,
              messages: [{ role: "user", content: "hi" }],
              session_id: expect.any(String),
            }),
          }),
        ]);
        expect(via.upstreamRequests).toEqual([]);
      }),
    ),
  );

  it.effect("streams a provider's answer back as it comes", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
        via.provider.respond(providerReply.sse(sse));

        const response = yield* via.post("/v1/chat/completions", {
          model: "openrouter/qwen/qwen3",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        });

        expect(response.headers["content-type"]).toContain("text/event-stream");
        expect(yield* response.text).toBe(sse);
      }),
    ),
  );

  it.effect("streams a leading <think> block as reasoning_content, not as the answer", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.sse(
            'data: {"choices":[{"index":0,"delta":{"content":"<think>Easy.</think>\\n"}}]}\n\n' +
              'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' +
              "data: [DONE]\n\n",
          ),
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/minimax-m3",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        });

        expect(yield* response.text).toBe(
          'data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":"Easy."}}]}\n\n' +
            'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
        );
      }),
    ),
  );

  it.effect("answers a completion's leading <think> block as reasoning_content", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(
          providerReply.json({
            choices: [
              { index: 0, message: { role: "assistant", content: "<think>Easy.</think>\n\nOK" } },
            ],
          }),
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "opencode-go/minimax-m3",
          messages: [{ role: "user", content: "hi" }],
        });

        expect(yield* response.json).toEqual({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK", reasoning_content: "Easy." },
            },
          ],
        });
      }),
    ),
  );

  it.effect("tells proxies not to cache or buffer any SSE answer, Codex's included", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.sse("data: [DONE]\n\n"));
        const messages = [{ role: "user", content: "hi" }];

        for (const [path, body] of [
          ["/v1/responses", { model: "gpt-6-astra", input: "hi", stream: true }],
          ["/v1/chat/completions", { model: "gpt-6-astra", messages, stream: true }],
          ["/v1/chat/completions", { model: "openrouter/qwen/qwen3", messages, stream: true }],
        ] as const) {
          const response = yield* via.post(path, body);
          expect(response.headers).toMatchObject({
            "content-type": expect.stringContaining("text/event-stream"),
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
          });
          yield* response.text;
        }
      }),
    ),
  );

  for (const [path, body, error] of [
    [
      "/v1/chat/completions",
      { messages: [{ role: "user", content: "hi" }] },
      (text: string) => JSON.parse(text.slice("data: ".length)).error,
    ],
    [
      "/v1/responses",
      { input: "hi" },
      (text: string) => JSON.parse(text.slice(text.indexOf("data: ") + "data: ".length)),
    ],
  ] as const) {
    it.effect(`ends a provider's ${path} stream that goes quiet for 5 minutes with an error`, () =>
      withVia(ok, (via) =>
        Effect.gen(function* () {
          const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
          via.provider.respond(providerReply.sseThenHang(sse));

          const response = yield* via.post(path, {
            model: "openrouter/qwen/qwen3",
            stream: true,
            ...body,
          });

          yield* Effect.forkChild(outwait(via, "5 minutes"));

          const events = (yield* response.text)
            .split("\n\n")
            .filter((event) => event !== "" && !event.startsWith(":"));

          expect(events[0]).toBe(sse.trimEnd());
          expect(events).toHaveLength(2);
          expect(error(events[1] ?? "")).toMatchObject({ code: "upstream_incomplete" });
          // The log still says the provider's stream broke off.
          expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
            stream_end: "failed",
          });
        }),
      ),
    );
  }

  it.effect(
    "ends a provider's stream that breaks off mid-event with an error event of its own",
    () =>
      withVia(ok, (via) =>
        Effect.gen(function* () {
          via.provider.respond(
            providerReply.sseThenHang('data: {"choices":[{"delta":{"content":"hel'),
          );

          // Waited out first: nothing goes out, headers included, until the event is whole.
          yield* Effect.forkChild(outwait(via, "5 minutes"));

          const response = yield* via.post("/v1/chat/completions", {
            model: "openrouter/qwen/qwen3",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          });

          const last = (yield* response.text)
            .split("\n\n")
            .filter((event) => event !== "" && !event.startsWith(":"))
            .at(-1);

          expect(last).toMatch(/^data: /);
          expect(JSON.parse((last ?? "").slice("data: ".length)).error).toMatchObject({
            code: "upstream_incomplete",
          });
        }),
      ),
  );

  it.effect("forwards a Responses request with the client's session", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json({ id: "resp_go" }));

        const response = yield* via.post(
          "/v1/responses",
          { model: "opencode-go/kimi-k3", input: "hi" },
          undefined,
          { "x-opencode-session": "ses_1" },
        );

        expect(yield* response.json).toEqual({ id: "resp_go" });
        expect(via.provider.requests[0]).toMatchObject({
          path: "/responses",
          headers: { "x-opencode-session": "ses_1" },
          body: { model: "kimi-k3", input: "hi" },
        });
      }),
    ),
  );

  it.effect("passes a provider's error through as it is", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const error = { error: { message: "slow down", code: 429 } };
        via.provider.respond(providerReply.json(error, 429));

        const response = yield* via.post("/v1/chat/completions", {
          model: "openrouter/qwen/qwen3",
          messages: [],
        });

        expect(response.status).toBe(429);
        expect(yield* response.json).toEqual(error);
      }),
    ),
  );

  it.effect("passes on only the client's headers a provider needs", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json(completion));

        const needed = {
          "anthropic-beta": "prompt-caching-2024-07-31",
          "openai-beta": "assistants=v2",
          "http-referer": "https://example.com",
          "x-title": "My app",
        };

        yield* via.post(
          "/v1/chat/completions",
          { model: "openrouter/qwen/qwen3", messages: [] },
          undefined,
          { ...needed, cookie: "session=secret", "x-api-key": "sk-client", "x-other": "1" },
        );

        const { headers } = via.provider.requests[0] ?? { headers: {} };
        expect(headers).toMatchObject({ ...needed, authorization: "Bearer sk-provider" });
        expect(headers).not.toHaveProperty("cookie");
        expect(headers).not.toHaveProperty("x-api-key");
        expect(headers).not.toHaveProperty("x-other");
      }),
    ),
  );

  it.effect("passes a provider's Retry-After and rate-limit headers through", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const limits = {
          "x-ratelimit-limit-requests": "60",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "20s",
        };

        via.provider.respond(
          providerReply.rateLimited({ "retry-after": "20", ...limits, "x-internal": "secret" }),
        );

        const response = yield* via.post("/v1/chat/completions", {
          model: "openrouter/qwen/qwen3",
          messages: [],
        });

        expect(response.status).toBe(429);
        expect(response.headers).toMatchObject({ "retry-after": "20", ...limits });
        expect(response.headers).not.toHaveProperty("x-internal");
      }),
    ),
  );

  it.effect("answers 502 when the provider can't be reached", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", {
            model: "openrouter/qwen/qwen3",
            input: "hi",
          });

          expect(response.status).toBe(502);
          expect(yield* response.json).toMatchObject({ error: { code: "upstream_unavailable" } });
        }),
      { providerUrl: "http://127.0.0.1:1" },
    ),
  );

  it.effect("sends models without a configured prefix to Codex", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", {
          model: "unknown/qwen3",
          input: "hi",
        });

        expect(response.status).toBe(200);
        expect(via.provider.requests).toEqual([]);
        expect(via.upstreamRequests[0]?.body).toMatchObject({ model: "unknown/qwen3" });
      }),
    ),
  );

  it.effect("moves OpenCode's session line out of the system prompt a provider is sent", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        via.provider.respond(providerReply.json(completion));
        yield* via.post("/v1/chat/completions", {
          model: "opencode-go/kimi-k3",
          messages: [
            { role: "system", content: "<env>\n  Current conversation session ID: ses_a\n</env>" },
            { role: "user", content: "hi" },
          ],
        });
        expect(via.provider.requests[0]?.body).toMatchObject({
          messages: [
            { role: "system", content: "<env>\n</env>" },
            { role: "user", content: "Current conversation session ID: ses_a\n\nhi" },
          ],
        });
      }),
    ),
  );
});
