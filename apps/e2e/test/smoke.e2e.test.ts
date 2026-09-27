import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { reply } from "@via/codex-upstream/testing";
import { openai, startCodex, withVia } from "./harness.ts";

// The whole product in one breath: login, key, serve, and a real OpenAI client
// talking to it, with the fake Codex backend behind it.
layer(BunFileSystem.layer)("via end to end", (it) => {
  it.effect("answers a chat completion from the pooled account", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("pong"));
      yield* withVia({ upstream: upstream.url }, (via) =>
        Effect.gen(function* () {
          const completion = yield* Effect.promise(() =>
            openai(via).chat.completions.create({
              model: "gpt-6-astra",
              messages: [{ role: "user", content: "ping" }],
            }),
          );

          expect(completion.choices[0]?.message.content).toBe("pong");
          expect(upstream.requests).toHaveLength(1);
          expect(upstream.requests[0]).toMatchObject({
            path: "/codex/responses",
            headers: {
              authorization: expect.stringMatching(/^Bearer \S+/),
              "chatgpt-account-id": "acc-123",
            },
            body: { model: "gpt-6-astra", stream: true, store: false },
          });
        }),
      );
    }),
  );

  it.effect("routes a seeded pool's first request to its oldest account", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.script(reply.text("pong"));
      yield* withVia({ upstream: upstream.url, accounts: [{ name: "a" }, { name: "b" }] }, (via) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            openai(via).responses.create({ model: "gpt-6-astra", input: "ping" }),
          );

          expect(response.output_text).toBe("pong");
          expect(upstream.requests[0]?.headers).toMatchObject({
            authorization: "Bearer at-a",
            "chatgpt-account-id": "acc-a",
          });
        }),
      );
    }),
  );
});
