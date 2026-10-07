import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply, sse, sseFrames } from "@via/codex-upstream/testing";
import { Clock, Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { outwait, type Via, withVia } from "./testing/harness.ts";

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

/**
 * Asks via on `path` for an answer Codex can't give whole, and checks the
 * client is told `message` while the log warns with it and `cause`, tied to the request.
 */
const unreadable = (
  via: Via,
  path: typeof CHAT | typeof RESPONSES,
  message: string,
  cause: string,
) =>
  Effect.gen(function* () {
    const answer = yield* via.post(path, bodies[path]);
    expect(answer.status).toBe(502);
    expect(yield* answer.json).toMatchObject({
      error: { type: "server_error", code: "upstream_incomplete", message },
    });

    const warning = yield* via.logged(`${message}: `);
    expect(warning.level).toBe("Warn");
    expect(warning.message).toContain(cause);
    expect(warning.annotations).toHaveProperty("request_id");
  });

layer(BunFileSystem.layer)("upstream faults", (it) => {
  it.effect(`${CHAT} says Codex's final response couldn't be read, and why`, () =>
    withVia(
      () => reply.sse(sse([created, { type: "response.completed", response: {} }])),
      (via) => unreadable(via, CHAT, "Codex's final response couldn't be read", "Missing key"),
    ),
  );

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

    it.effect(`${path} says a garbled Codex stream held an event via can't read, and why`, () =>
      withVia(
        () => reply.sse(`${sse([created])}event: response.completed\ndata: {not json\n\n`),
        (via) =>
          unreadable(
            via,
            path,
            "Codex sent an event via can't read",
            "Expected a valid JSON string",
          ),
      ),
    );

    it.effect(`${path} says a Codex stream asked to be retried mid-answer, and how soon`, () =>
      withVia(
        () => reply.sse(`${sse([created])}retry: 1000\n\n`),
        (via) =>
          unreadable(via, path, "Codex asked to be retried in the middle of its answer", "in 1s"),
      ),
    );

    it.effect(`${path} says a Codex connection broke off mid-answer, and why`, () =>
      withVia(
        () => reply.hangUp(reply.text("hello"), 2),
        (via) =>
          unreadable(
            via,
            path,
            "The connection to Codex broke off in the middle of its answer",
            "The socket connection was closed unexpectedly",
          ),
      ),
    );

    it.effect(`${path} answers a Codex response that never completes with 504 in 30 minutes`, () =>
      withVia(
        () => reply.stalled(reply.text("hello"), 2),
        (via) =>
          Effect.gen(function* () {
            const pending = yield* via.post(path, bodies[path]).pipe(Effect.forkChild);
            const start = yield* Clock.currentTimeMillis;
            // Codex's headers reached via, which now gives the rest of the response 30 minutes.
            yield* via.timer("30 minutes");
            yield* TestClock.adjust("30 minutes");
            const answer = yield* Fiber.join(pending);
            expect(answer.status).toBe(504);
            expect((yield* Clock.currentTimeMillis) - start).toBeGreaterThanOrEqual(30 * 60_000);
            expect(yield* answer.json).toMatchObject({
              error: { type: "server_error", code: "upstream_timeout" },
            });
          }),
      ),
    );

    it.effect(`${path} answers a Codex response that goes quiet for 5 minutes with 504`, () =>
      withVia(
        () => reply.stalled(reply.text("hello"), 2),
        (via) =>
          Effect.gen(function* () {
            yield* Effect.forkChild(outwait(via, "5 minutes"));
            const answer = yield* via.post(path, bodies[path]);
            expect(answer.status).toBe(504);
            expect(yield* answer.json).toMatchObject({
              error: { type: "server_error", code: "upstream_timeout" },
            });
            yield* via.upstreamHungUp(1);
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
            const relayed = yield* Deferred.make<void>();

            const reading = yield* answer.stream.pipe(
              Stream.runForEach(() => Deferred.succeed(relayed, undefined)),
              Effect.forkChild,
            );

            const hungUp = yield* via.upstreamHungUp(1).pipe(Effect.forkChild);

            // While the client reads what Codex sent, via keeps reading from Codex.
            yield* Deferred.await(relayed);
            expect(hungUp.pollUnsafe()).toBeUndefined();
            yield* Fiber.interrupt(reading);
            yield* Fiber.join(hungUp);
          }),
      ),
    );
  }

  it.effect(`a ${RESPONSES} stream Codex goes quiet on for 5 minutes ends in an error event`, () =>
    withVia(
      () => reply.stalled(reply.text("hello"), 2),
      (via) =>
        Effect.gen(function* () {
          const answer = yield* via.post(RESPONSES, { ...bodies[RESPONSES], stream: true });
          // via waits 5 minutes for Codex's next chunk, then gives up on it.
          yield* Effect.forkChild(outwait(via, "5 minutes"));
          const frames = sseFrames(yield* answer.text);
          expect(frames.at(-1)?.event).toBe("error");
          expect(JSON.parse(frames.at(-1)?.data ?? "")).toMatchObject({
            code: "upstream_incomplete",
          });
          yield* via.upstreamHungUp(1);
        }),
    ),
  );

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
