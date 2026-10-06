import { describe, expect, it } from "@effect/vitest";
import { type Cause, Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { keepAlive } from "./keep-alive.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const decoder = new TextDecoder();

/** Runs `keepAlive` over chunks a test offers, collecting what it sends as text. */
const relay = Effect.gen(function* () {
  const upstream = yield* Queue.make<string, Cause.Done>();
  const sent: Array<string> = [];

  const fiber = yield* keepAlive(Stream.fromQueue(upstream).pipe(Stream.map(encode))).pipe(
    Stream.runForEach((chunk) => Effect.sync(() => sent.push(decoder.decode(chunk)))),
    Effect.forkChild,
  );

  const offer = (text: string) => Effect.andThen(Queue.offer(upstream, text), Effect.yieldNow);

  return { sent, offer, end: Queue.end(upstream), fiber };
});

describe("keepAlive", () => {
  it.effect("sends an SSE comment after five quiet seconds between events", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* relay;
      yield* offer('data: {"a":1}\n\n');
      yield* TestClock.adjust("5 seconds");
      expect(sent).toEqual(['data: {"a":1}\n\n', ": keepalive\n\n"]);
    }),
  );

  it.effect("keeps sending one every five quiet seconds", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* relay;
      yield* offer("data: 1\n\n");
      yield* TestClock.adjust("15 seconds");
      expect(sent.filter((chunk) => chunk === ": keepalive\n\n")).toHaveLength(3);
    }),
  );

  it.effect("sends none while events keep coming", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* relay;

      for (let i = 0; i < 6; i++) {
        yield* offer(`data: ${i}\n\n`);
        yield* TestClock.adjust("4 seconds");
      }

      expect(sent).not.toContain(": keepalive\n\n");
    }),
  );

  it.effect("never cuts into an event that is still arriving", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* relay;
      yield* offer('data: {"a":');
      yield* TestClock.adjust("20 seconds");
      expect(sent).toEqual(['data: {"a":']);
    }),
  );

  it.effect("finds the end of an event framed with CRLF, or split across chunks", () =>
    Effect.gen(function* () {
      for (const chunks of [["data: 1\r\n\r\n"], ["data: 1\n", "\n"], ["data: 1\r\r"]]) {
        const { sent, offer } = yield* relay;

        for (const chunk of chunks) yield* offer(chunk);
        yield* TestClock.adjust("5 seconds");
        expect(sent.at(-1)).toBe(": keepalive\n\n");
      }
    }),
  );

  it.effect("never cuts in after a single CRLF, which ends a line, not an event", () =>
    Effect.gen(function* () {
      const { sent, offer } = yield* relay;
      yield* offer("data: 1\r\n");
      yield* TestClock.adjust("20 seconds");
      expect(sent).toEqual(["data: 1\r\n"]);
    }),
  );

  it.effect("ends when the stream it relays ends", () =>
    Effect.gen(function* () {
      const { sent, offer, end, fiber } = yield* relay;
      yield* offer("data: [DONE]\n\n");
      yield* end;
      yield* Fiber.join(fiber);
      expect(sent).toEqual(["data: [DONE]\n\n"]);
    }),
  );
});
