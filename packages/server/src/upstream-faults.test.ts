import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply, sse, sseFrames } from "@via/codex-upstream/testing";
import { Clock, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { withVia } from "./testing/harness.ts";

/** A pause on the real clock, for via to act on what a socket brought; a TestClock can't freeze it. */
const realPause = Effect.sleep("5 millis").pipe(
  Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
);

/** Moves test time on a minute at a time until `fiber` is done, and answers its result. */
const advanceUntilDone = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("1 minute");
      yield* realPause;
    }

    return yield* Fiber.join(fiber);
  });

// What a client sees when Codex breaks: an OpenAI-shaped server error.
const response = {
  id: "resp_1",
  created_at: 1_700_000_000,
  model: "gpt-6-astra",
};

const created = {
  type: "response.created",
  response: { ...response, status: "in_progress" },
};

/** A reasoning delta of 1 MiB, as one SSE frame. */
const megabyte = sse([{ type: "response.reasoning_text.delta", delta: "x".repeat(1024 * 1024) }]);

const cutOff = () => reply.sse(sse([created]));

const failed = () =>
  reply.sse(
    sse([
      created,
      {
        type: "response.failed",
        response: {
          ...response,
          status: "failed",
          error: { code: "server_is_overloaded", message: "Codex is busy" },
        },
      },
    ]),
  );

const CHAT = "/v1/chat/completions";

const RESPONSES = "/v1/responses";

const bodies = {
  [CHAT]: { model: "gpt-6-astra", messages: [{ role: "user", content: "hi" }] },
  [RESPONSES]: { model: "gpt-6-astra", input: "hi" },
};

layer(BunFileSystem.layer)("upstream faults", (it) => {
  for (const path of [CHAT, RESPONSES] as const) {
    it.effect(`${path} answers a cut-off Codex stream with 502 upstream_incomplete`, () =>
      withVia(cutOff, (via) =>
        Effect.gen(function* () {
          const answer = yield* via.post(path, bodies[path]);
          expect(answer.status).toBe(502);
          expect(yield* answer.json).toMatchObject({
            error: { type: "server_error", code: "upstream_incomplete" },
          });
        }),
      ),
    );

    it.effect(`${path} answers a failed Codex response with 502 and its code`, () =>
      withVia(failed, (via) =>
        Effect.gen(function* () {
          const answer = yield* via.post(path, bodies[path]);
          expect(answer.status).toBe(502);
          expect(yield* answer.json).toMatchObject({
            error: {
              type: "server_error",
              code: "server_is_overloaded",
              message: "Codex is busy",
            },
          });
        }),
      ),
    );

    it.effect(`${path} answers a garbled Codex stream with 502 upstream_incomplete`, () =>
      withVia(
        () => reply.sse(`${sse([created])}event: response.completed\ndata: {not json\n\n`),
        (via) =>
          Effect.gen(function* () {
            const answer = yield* via.post(path, bodies[path]);
            expect(answer.status).toBe(502);
            expect(yield* answer.json).toMatchObject({
              error: { type: "server_error", code: "upstream_incomplete" },
            });
          }),
      ),
    );

    it.effect(
      `${path} answers a Codex stream asking to be retried with 502 upstream_incomplete`,
      () =>
        withVia(
          () => reply.sse(`${sse([created])}retry: 1000\n\n`),
          (via) =>
            Effect.gen(function* () {
              const answer = yield* via.post(path, bodies[path]);
              expect(answer.status).toBe(502);
              expect(yield* answer.json).toMatchObject({
                error: { type: "server_error", code: "upstream_incomplete" },
              });
            }),
        ),
    );

    it.effect(
      `${path} answers a Codex connection broken mid-stream with 502 upstream_incomplete`,
      () =>
        withVia(
          () => reply.hangUp(reply.text("hello"), 2),
          (via) =>
            Effect.gen(function* () {
              const answer = yield* via.post(path, bodies[path]);
              expect(answer.status).toBe(502);
              expect(yield* answer.json).toMatchObject({
                error: { type: "server_error", code: "upstream_incomplete" },
              });
            }),
        ),
    );

    it.effect(`${path} answers a Codex response that never completes with 504 in 30 minutes`, () =>
      withVia(
        () => reply.stalled(reply.text("hello"), 2),
        (via) =>
          Effect.gen(function* () {
            const pending = yield* via.post(path, bodies[path]).pipe(Effect.forkChild);
            yield* via.upstreamReceived(1);
            const start = yield* Clock.currentTimeMillis;
            const answer = yield* advanceUntilDone(pending);
            expect(answer.status).toBe(504);
            expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThanOrEqual(30 * 60_000);
            expect(yield* answer.json).toMatchObject({
              error: { type: "server_error", code: "upstream_timeout" },
            });
          }),
      ),
    );

    // Past a cap of 4 MiB rather than the real 128 MiB, which is slow to stream through via.
    it.effect(`${path} answers a Codex stream that runs past its size cap with 502`, () =>
      withVia(
        () => () => ({
          status: 200,
          headers: {},
          contentType: "text/event-stream",
          chunks: Array.from({ length: 5 }, () => megabyte),
          ending: "close",
        }),
        (via) =>
          Effect.gen(function* () {
            const answer = yield* via.post(path, bodies[path]);
            expect(answer.status).toBe(502);
            expect(yield* answer.json).toMatchObject({
              error: {
                type: "server_error",
                code: "upstream_too_large",
                message: expect.stringContaining("past 4 MiB"),
              },
            });
          }),
        { maxResponseBytes: 4 * 1024 * 1024 },
      ),
    );

    it.effect(`${path} answers an unreachable Codex with 502 upstream_unavailable`, () =>
      withVia(
        cutOff,
        (via) =>
          Effect.gen(function* () {
            const answer = yield* via.post(path, bodies[path]);
            expect(answer.status).toBe(502);
            expect(yield* answer.json).toMatchObject({
              error: { type: "server_error", code: "upstream_unavailable" },
            });
          }),
        // Nothing listens on port 1, so the connection is refused.
        { codexUrl: "http://127.0.0.1:1" },
      ),
    );
  }

  it.effect(`${RESPONSES} rejects a body that is not an object with 400`, () =>
    withVia(cutOff, (via) =>
      Effect.gen(function* () {
        const answer = yield* via.post(RESPONSES, [1, 2, 3]);
        expect(answer.status).toBe(400);
        expect(yield* answer.json).toMatchObject({
          error: { type: "invalid_request_error", code: "invalid_request" },
        });
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );

  for (const path of [CHAT, RESPONSES] as const) {
    it.effect(`a client hanging up on a ${path} stream hangs up on Codex too`, () =>
      withVia(
        () => reply.stalled(reply.text("hello"), 3),
        (via) =>
          Effect.gen(function* () {
            const answer = yield* via.post(path, { ...bodies[path], stream: true });
            const reading = yield* answer.stream.pipe(Stream.runDrain, Effect.forkChild);
            const hungUp = yield* via.upstreamHungUp(1).pipe(Effect.forkChild);
            yield* realPause.pipe(Effect.repeat({ times: 40 }));
            // While the client reads, via keeps reading from Codex.
            expect(hungUp.pollUnsafe()).toBeUndefined();
            yield* Fiber.interrupt(reading);
            yield* Fiber.join(hungUp);
          }),
      ),
    );
  }

  it.effect(`a ${RESPONSES} stream cut off by Codex ends in an error event`, () =>
    withVia(cutOff, (via) =>
      Effect.gen(function* () {
        const text = yield* (yield* via.post(RESPONSES, {
          ...bodies[RESPONSES],
          stream: true,
        })).text;

        const frames = sseFrames(text);
        expect(frames.map((frame) => frame.event)).toEqual(["response.created", "error"]);
        expect(JSON.parse(frames.at(-1)?.data ?? "")).toMatchObject({
          type: "error",
          code: "upstream_incomplete",
        });
      }),
    ),
  );

  it.effect(`${CHAT} finishes an incomplete Codex response with length`, () =>
    withVia(
      () =>
        reply.sse(
          sse([
            created,
            {
              type: "response.incomplete",
              response: {
                ...response,
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                output: [
                  {
                    type: "message",
                    content: [{ type: "output_text", text: "Hel" }],
                  },
                ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]),
        ),
      (via) =>
        Effect.gen(function* () {
          const answer = yield* via.post(CHAT, bodies[CHAT]);
          expect(answer.status).toBe(200);
          expect(yield* answer.json).toMatchObject({
            choices: [{ message: { content: "Hel" }, finish_reason: "length" }],
          });
        }),
    ),
  );
});
