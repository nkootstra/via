import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { completedStream, sse } from "./testing/streams.ts";
import {
  collectResponse,
  IncompleteStreamError,
  ResponseTimeoutError,
  ResponseTooLargeError,
  UpstreamFailedError,
} from "./index.ts";

/** The SSE text as a byte stream, cut into `size`-byte chunks like a network would. */
const bytes = (text: string, size = 7) => {
  const encoded = new TextEncoder().encode(text);

  const chunks = Array.from({ length: Math.ceil(encoded.length / size) }, (_, i) =>
    encoded.slice(i * size, (i + 1) * size),
  );

  return Stream.fromIterable(chunks);
};

describe("collectResponse", () => {
  it.effect("returns the final response of a completed stream", () =>
    Effect.gen(function* () {
      const response = yield* collectResponse(bytes(completedStream("hello")));
      expect(response).toMatchObject({
        id: "resp_1",
        status: "completed",
        output: [{ content: [{ text: "hello" }] }],
      });
    }),
  );

  it.effect("fails with the upstream error when the response failed", () =>
    Effect.gen(function* () {
      const failed = sse([
        {
          type: "response.failed",
          response: { id: "resp_1", error: { code: "server_error", message: "boom" } },
        },
      ]);

      const error = yield* Effect.flip(collectResponse(bytes(failed)));
      expect(error).toEqual(new UpstreamFailedError({ code: "server_error", reason: "boom" }));
    }),
  );

  it.effect("fails when the stream ends before the response completes", () =>
    Effect.gen(function* () {
      const cut = sse([{ type: "response.created", response: { id: "resp_1" } }]);
      const error = yield* Effect.flip(collectResponse(bytes(cut)));
      expect(error).toBeInstanceOf(IncompleteStreamError);
      expect(error).toMatchObject({
        message: "The Codex stream ended before the response completed",
      });
    }),
  );

  it.effect("fails when the stream ends after an item but before the response completes", () =>
    Effect.gen(function* () {
      const cut = sse([{ type: "response.output_item.done", item: { type: "message" } }]);
      const error = yield* Effect.flip(collectResponse(bytes(cut)));
      expect(error).toBeInstanceOf(IncompleteStreamError);
    }),
  );

  it.effect("keeps the final output when Codex filled it in", () =>
    Effect.gen(function* () {
      const text = sse([
        { type: "response.output_item.done", item: { type: "message", id: "streamed" } },
        { type: "response.completed", response: { id: "resp_1", output: [{ id: "final" }] } },
      ]);

      expect((yield* collectResponse(bytes(text)))["output"]).toEqual([{ id: "final" }]);
    }),
  );

  it.effect("stops reading at the terminal event", () =>
    Effect.gen(function* () {
      const text = sse([{ type: "response.completed", response: { id: "resp_1" } }]);

      const response = yield* collectResponse(
        bytes(text).pipe(Stream.concat(Stream.fail("connection reset"))),
      );

      expect(response).toEqual({ id: "resp_1", output: [] });
    }),
  );

  it.effect("fails as incomplete when a failed response carries no error", () =>
    Effect.gen(function* () {
      const failed = sse([{ type: "response.failed", response: { id: "resp_1" } }]);
      const error = yield* Effect.flip(collectResponse(bytes(failed)));
      expect(error).toBeInstanceOf(IncompleteStreamError);
    }),
  );

  it.effect("gives up on a stream past 128 MiB, which no real response comes near", () =>
    Effect.gen(function* () {
      // One reasoning delta of 1 MiB, sent over and over; each is dropped as it arrives.
      const delta = new TextEncoder().encode(
        sse([{ type: "response.reasoning_text.delta", delta: "x".repeat(1024 * 1024) }]),
      );

      const endless = Stream.fromIterable([delta]).pipe(Stream.forever);
      const error = yield* Effect.flip(collectResponse(endless));
      expect(error).toEqual(new ResponseTooLargeError({ maxBytes: 128 * 1024 * 1024 }));
    }),
  );

  it.effect("gives up on a response that has not completed after 30 minutes", () =>
    Effect.gen(function* () {
      const started = sse([{ type: "response.created", response: { id: "resp_1" } }]);

      const collecting = yield* collectResponse(
        bytes(started).pipe(Stream.concat(Stream.never)),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("30 minutes");
      expect(yield* Fiber.join(collecting)).toBeInstanceOf(ResponseTimeoutError);
    }),
  );
});
