import { describe, expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { sse, sseFrames } from "./testing/streams.ts";
import { relayStream } from "./relay-stream.ts";

const created = { type: "response.created", response: { id: "resp_1" } };

const completed = { type: "response.completed", response: { id: "resp_1" } };

const bytes = (text: string) => Stream.make(new TextEncoder().encode(text));

const relayed = <E>(body: Stream.Stream<Uint8Array, E>) =>
  relayStream(body).pipe(Stream.decodeText, Stream.mkString);

const lastFrame = (text: string) => sseFrames(text).at(-1);

describe("relayStream", () => {
  it.effect("passes a complete stream through unchanged", () =>
    Effect.gen(function* () {
      const text = sse([created, { type: "response.output_text.delta", delta: "hi" }, completed]);
      expect(yield* relayed(bytes(text))).toBe(text);
    }),
  );

  it.effect("passes a failed response through as the last event", () =>
    Effect.gen(function* () {
      const failed = {
        type: "response.failed",
        response: { error: { code: "server_is_overloaded", message: "busy" } },
      };

      expect(yield* relayed(bytes(sse([created, failed])))).toBe(sse([created, failed]));
    }),
  );

  it.effect("ends a stream cut off before its terminal event with an error event", () =>
    Effect.gen(function* () {
      const last = lastFrame(yield* relayed(bytes(sse([created]))));
      expect(last?.event).toBe("error");
      expect(JSON.parse(last?.data ?? "")).toMatchObject({
        type: "error",
        code: "upstream_incomplete",
        message: expect.any(String),
      });
    }),
  );

  it.effect("ends a stream that broke while reading with an error event", () =>
    Effect.gen(function* () {
      const text = yield* relayed(
        bytes(sse([created])).pipe(Stream.concat(Stream.fail("connection reset"))),
      );

      expect(text).toBe(sse([created]) + text.slice(sse([created]).length));
      expect(sseFrames(text).filter((frame) => frame.event === "error")).toHaveLength(1);
      expect(lastFrame(text)?.data).toContain('"code":"upstream_incomplete"');
    }),
  );

  it.effect("stops at the terminal event, ignoring whatever breaks after it", () =>
    Effect.gen(function* () {
      const text = sse([created, completed]);

      const relayedText = yield* relayed(
        bytes(text).pipe(Stream.concat(Stream.fail("connection reset"))),
      );

      expect(relayedText).toBe(text);
    }),
  );
});
