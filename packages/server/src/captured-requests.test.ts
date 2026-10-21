import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, reply, sse } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { UsageHistory } from "@via/usage";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import type { HttpClientResponse } from "effect/http";
import { ok, type Via, withVia } from "./testing/harness.ts";

const accountOf = (request: CodexRequest) => request.headers["chatgpt-account-id"];

/** A key a client pasted into its prompt, which via must never keep. */
const KEY = "sk-proj-Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789_-abcd";

/** Codex's answer to an account whose usage limit is reached, quoting the client's key back. */
const usageLimit = reply.error(429, {
  error: { type: "usage_limit_reached", message: `The usage limit has been reached for ${KEY}` },
});

/** What via captured of the request `response` answered, once it has logged it. */
const capturedOf = (via: Via, response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    yield* response.text;
    yield* via.logged("Sent HTTP response");

    return yield* via.captured.get(response.headers["x-request-id"] ?? "");
  });

const chat = {
  model: "gpt-x",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: `Why does ${KEY} fail?` },
  ],
};

layer(BunFileSystem.layer)("captured requests", (it) => {
  it.effect("keeps nothing of a failed turn until told to", () =>
    withVia(
      () => usageLimit,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/chat/completions", chat);

          expect(response.status).toBe(429);
          expect(yield* capturedOf(via, response)).toEqual(Option.none());
        }),
    ),
  );

  it.effect("keeps a failed turn's request and every upstream's answer, redacted", () =>
    withVia(
      () => usageLimit,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/chat/completions", chat);
          const captured = yield* capturedOf(via, response);

          expect(captured).toEqual(
            Option.some({
              requestId: response.headers["x-request-id"],
              capturedAt: expect.any(Number),
              endpoint: "chat/completions",
              request: {
                model: "gpt-x",
                messages: [
                  { role: "system", content: "You are helpful." },
                  { role: "user", content: "Why does [redacted:openai-key] fail?" },
                ],
              },
              upstreamErrors: [0, 1].map((seq) => ({
                seq,
                status: 429,
                body: {
                  error: {
                    type: "usage_limit_reached",
                    message: "The usage limit has been reached for [redacted:openai-key]",
                  },
                },
              })),
              redactions: [{ kind: "openai-key", count: 3 }],
              truncated: false,
              sizeBytes: expect.any(Number),
            }),
          );

          expect(JSON.stringify(captured)).not.toContain(KEY);
        }),
      { keepFailedPrompts: true },
    ),
  );

  it.effect("keeps what Codex said when it failed the response in its stream", () =>
    withVia(
      () =>
        reply.sse(
          sse([
            { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
            {
              type: "response.failed",
              response: {
                id: "resp_1",
                status: "failed",
                error: { code: "server_is_overloaded", message: "Codex is busy" },
              },
            },
          ]),
        ),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", { model: "gpt-x", input: "hi" });

          expect(yield* capturedOf(via, response)).toMatchObject(
            Option.some({
              upstreamErrors: [
                {
                  seq: 0,
                  status: 200,
                  body: { error: { code: "server_is_overloaded", message: "Codex is busy" } },
                },
              ],
            }),
          );
        }),
      { keepFailedPrompts: true },
    ),
  );

  it.effect("keeps a turn that fell back to another model", () =>
    withVia(
      () => reply.error(429, "", { "retry-after": "120" }),
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json({ choices: [] }));

          const response = yield* via.post("/v1/responses", { model: "gpt-x", input: "hi" });
          const captured = yield* capturedOf(via, response);

          expect(response.status).toBe(200);
          expect(captured).toMatchObject(
            Option.some({
              endpoint: "responses",
              request: { model: "gpt-x", input: "hi" },
              upstreamErrors: [
                { seq: 0, status: 429, body: "" },
                { seq: 1, status: 429, body: "" },
              ],
            }),
          );
        }),
      {
        keepFailedPrompts: true,
        fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }],
      },
    ),
  );

  it.effect("keeps nothing of a turn that went well, even when told to keep failed ones", () =>
    withVia(
      (request) => (accountOf(request) === "acc-a" ? usageLimit : ok()),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", { model: "gpt-x", input: "hi" });

          expect(response.status).toBe(200);
          expect(yield* capturedOf(via, response)).toEqual(Option.none());
        }),
      { keepFailedPrompts: true },
    ),
  );

  it.effect("keeps each failed turn apart, even when its client repeats its x-request-id", () =>
    withVia(
      () => usageLimit,
      (via) =>
        Effect.gen(function* () {
          const headers = { "x-request-id": "550e8400-e29b-41d4-a716-446655440000" };

          for (const input of ["first", "second"]) {
            const response = yield* via.post(
              "/v1/responses",
              { model: "gpt-x", input },
              undefined,
              headers,
            );

            yield* response.text;
          }

          const page = yield* via.usage.requests({
            from: 0,
            to: Number.MAX_SAFE_INTEGER,
            limit: 10,
          });

          const inputs = yield* Effect.forEach(page.requests, (request) =>
            Effect.map(via.captured.get(request.requestId), (captured) =>
              Option.map(captured, (found) => found.request),
            ),
          );

          expect(
            inputs.map((found) => JSON.stringify(Option.getOrThrow(found))).toSorted(),
          ).toEqual(['{"model":"gpt-x","input":"first"}', '{"model":"gpt-x","input":"second"}']);
        }),
      { keepFailedPrompts: true },
    ),
  );

  it.effect("answers a failed turn without waiting for its capture and history to be written", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();

      // A history that holds every request it keeps until it is let go.
      const history = Layer.effect(
        UsageHistory,
        Effect.map(UsageHistory, (usage) =>
          UsageHistory.of({
            ...usage,
            keep: (entry, attempts) =>
              Effect.andThen(Deferred.await(release), usage.keep(entry, attempts)),
          }),
        ),
      ).pipe(Layer.provide(UsageHistory.layerMemory));

      yield* withVia(
        () => usageLimit,
        (via) =>
          Effect.gen(function* () {
            const answered = yield* Effect.forkChild(
              Effect.flatMap(via.post("/v1/chat/completions", chat), (response) =>
                Effect.as(response.text, response),
              ),
            );

            const response = yield* Fiber.join(answered);
            expect(response.status).toBe(429);

            // Answered while the history still holds the request back.
            const kept = yield* via.usage.requests({
              from: 0,
              to: Number.MAX_SAFE_INTEGER,
              limit: 1,
            });

            expect(kept.requests).toEqual([]);

            yield* Deferred.succeed(release, undefined);
            expect(Option.isSome(yield* capturedOf(via, response))).toBe(true);
          }),
        { keepFailedPrompts: true, history },
      );
    }),
  );
});
