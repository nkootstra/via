import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { reply } from "@via/codex-upstream/testing";
import { chat, launchVia, openai, responsesOf, startCodex } from "./harness.ts";

// The whole product in one breath: login, key, serve, and a real OpenAI client
// talking to it, with the fake Codex backend behind it.
layer(BunFileSystem.layer)("via end to end", (it) => {
  it.effect("answers a chat completion from the pooled account", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("pong"));
      const via = yield* launchVia({ upstream: upstream.url });

      const completion = yield* chat(via, "ping");

      expect(completion.choices[0]?.message.content).toBe("pong");
      expect(responsesOf(upstream)).toHaveLength(1);
      expect(responsesOf(upstream)[0]).toMatchObject({
        path: "/codex/responses",
        headers: {
          authorization: expect.stringMatching(/^Bearer \S+/),
          "chatgpt-account-id": "acc-123",
        },
        body: { model: "gpt-6-astra", stream: true, store: false },
      });
    }),
  );

  it.effect("routes a seeded pool's first request to its oldest account", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("pong"));

      const via = yield* launchVia({
        upstream: upstream.url,
        accounts: [{ name: "a" }, { name: "b" }],
      });

      const response = yield* Effect.promise(() =>
        openai(via).responses.create({ model: "gpt-6-astra", input: "ping" }),
      );

      expect(response.output_text).toBe("pong");
      expect(responsesOf(upstream)[0]?.headers).toMatchObject({
        authorization: "Bearer at-a",
        "chatgpt-account-id": "acc-a",
      });
    }),
  );

  it.effect("answers a health check without a key", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      const via = yield* launchVia({ upstream: upstream.url });

      const response = yield* Effect.promise(() => fetch(`${via.url}/healthz`));

      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("ok");
    }),
  );

  it.effect("echoes the client's x-request-id, lower-cased, and makes one up otherwise", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: upstream.url });
      const sent = "0B7E4C1A-5D2F-4E8B-9C3A-1F6D2E4B8A70";

      const request = (headers: Record<string, string>) =>
        Effect.promise(() =>
          openai(via)
            .chat.completions.create(
              { model: "gpt-6-astra", messages: [{ role: "user", content: "ping" }] },
              { headers },
            )
            .withResponse(),
        ).pipe(Effect.map(({ response }) => response.headers.get("x-request-id")));

      expect(yield* request({ "x-request-id": sent })).toBe(sent.toLowerCase());
      const made = yield* request({ "x-request-id": "not-a-uuid" });
      expect(made).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(made).not.toBe(sent.toLowerCase());
    }),
  );
});
