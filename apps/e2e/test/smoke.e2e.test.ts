import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { openai, startAimock, withVia } from "./harness.ts";

// The whole product in one breath: login, key, serve, and a real OpenAI client
// talking to it, with aimock standing in for the Codex backend.
layer(BunFileSystem.layer)("via end to end", (it) => {
  it.effect("answers a chat completion from the pooled account", () =>
    Effect.gen(function* () {
      const upstream = yield* startAimock;
      upstream.mock.onMessage("ping", { content: "pong" });
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
});
