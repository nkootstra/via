import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream, reply } from "@via/codex-upstream/testing";
import { Effect, Stream } from "effect";
import OpenAI from "openai";
import { type Via, withVia } from "./harness.ts";

const ok = () => reply.sse(completedStream("hello"));
const client = (via: Via) => new OpenAI({ baseURL: `${via.baseUrl}/v1`, apiKey: via.key });

// The official SDK is the client most scripts use, so it must accept via's answers as-is.
layer(BunFileSystem.layer)("the openai SDK", (it) => {
  it.effect("creates a chat completion", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const completion = yield* Effect.promise(() =>
          client(via).chat.completions.create({
            model: "gpt-6-astra",
            messages: [{ role: "user", content: "hi" }],
          }),
        );
        expect(completion.choices[0]?.message.content).toBe("hello");
      }),
    ),
  );

  it.effect("streams a chat completion", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const chunks = yield* Effect.promise(() =>
          client(via).chat.completions.create({
            model: "gpt-6-astra",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        );
        const text = yield* Stream.fromAsyncIterable(chunks, (error) => error).pipe(
          Stream.map((chunk) => chunk.choices[0]?.delta.content ?? ""),
          Stream.mkString,
        );
        expect(text).toBe("hello");
      }),
    ),
  );

  it.effect("creates a response", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          client(via).responses.create({ model: "gpt-6-astra", input: "hi" }),
        );
        expect(response.output_text).toBe("hello");
      }),
    ),
  );

  it.effect("lists the models", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const page = yield* Effect.promise(() => client(via).models.list());
        expect(page.data.map((model) => model.id)).toContain("gpt-6-astra-high");
      }),
    ),
  );
});
