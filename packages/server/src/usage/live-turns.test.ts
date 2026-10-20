import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Queue, Schema, Stream } from "effect";
import { LiveTurns } from "./live-turns.ts";
import type { LiveAttempt, LiveTurn, TurnEvent } from "./turn-events.ts";

const turn = (requestId: string, at = 1_000): LiveTurn => ({
  requestId,
  at,
  model: "gpt-6-astra",
  conversationId: Option.some("ses_1"),
  parentConversationId: Option.none(),
  agentType: Option.none(),
  client: Option.some("opencode/1.19.3"),
  keyName: Option.some("laptop"),
  attempts: [],
});

const open = (requestId: string, seq: number): LiveAttempt => ({
  state: "open",
  requestId,
  seq,
  startedAt: 1_000 + seq,
  provider: "codex",
  model: "gpt-6-astra",
  accountId: Option.some("acc-a"),
  accountLabel: Option.some("a@example.com"),
  status: Option.none(),
  firstChunkMs: Option.none(),
});

const failed = (requestId: string, seq: number): LiveAttempt => ({
  state: "ended",
  requestId,
  seq,
  startedAt: 1_000 + seq,
  durationMs: 5,
  firstChunkMs: Option.none(),
  provider: "codex",
  model: "gpt-6-astra",
  accountId: Option.some("acc-a"),
  accountLabel: Option.some("a@example.com"),
  status: Option.some(429),
  outcome: "failed",
  category: Option.some("rate_limited"),
  upstreamCode: Option.none(),
  downstreamProvider: Option.none(),
  message: Option.none(),
});

/** The end of request `requestId`, as history keeps it. */
const ended = (requestId: string) => ({
  entry: {
    requestId,
    at: 1_000,
    status: 200,
    error: Option.none(),
    errorMessage: Option.none(),
    streamEnd: Option.none(),
    keyId: Option.none(),
    keyName: Option.none(),
    model: "gpt-6-astra",
    provider: "codex",
    accountId: Option.none(),
    accountLabel: Option.none(),
    inputTokens: Option.none(),
    cachedTokens: Option.none(),
    cacheWriteTokens: Option.none(),
    outputTokens: Option.none(),
    reasoningTokens: Option.none(),
    costUsd: Option.none(),
    durationMs: 10,
    firstChunkMs: Option.none(),
    requestedModel: Option.none(),
    fallbackReason: Option.none(),
    conversationId: Option.some("ses_1"),
    parentConversationId: Option.none(),
    sessionSource: Option.none(),
    agentType: Option.none(),
    client: Option.none(),
  },
  attempts: [],
});

/**
 * Listens to `live`'s events for as long as the scope, into a queue. Its first event,
 * the `turn.started` of `connected`, which is in flight as it connects, is taken, so
 * whatever happens next reaches it.
 */
const listen = (live: LiveTurns["Service"], connected: string) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<TurnEvent>();
    yield* Effect.forkScoped(Stream.runForEach(live.events, (event) => Queue.offer(events, event)));
    const first = yield* Queue.take(events);
    expect(first).toMatchObject({ event: "turn.started", data: { requestId: connected } });

    return events;
  });

const take = (events: Queue.Queue<TurnEvent>, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => Queue.take(events));

it.effect("sends a turn as it starts, each attempt as it changes, and the turn's end", () =>
  Effect.gen(function* () {
    const live = yield* LiveTurns;
    yield* live.start(turn("r0"));
    const events = yield* listen(live, "r0");

    yield* live.start(turn("r1"));
    yield* live.attempt(open("r1", 0));
    yield* live.attempt(failed("r1", 0));
    yield* live.end(ended("r1"));

    expect(yield* take(events, 4)).toEqual([
      { event: "turn.started", data: turn("r1") },
      { event: "turn.attempt", data: open("r1", 0) },
      { event: "turn.attempt", data: failed("r1", 0) },
      { event: "turn.ended", data: ended("r1") },
    ]);
  }).pipe(Effect.scoped, Effect.provide(LiveTurns.layer)),
);

it.effect(
  "sends a listener that connects mid-turn each turn in flight, with its attempts so far",
  () =>
    Effect.gen(function* () {
      const live = yield* LiveTurns;
      yield* live.start(turn("r1", 1_000));
      yield* live.attempt(failed("r1", 0));
      yield* live.attempt(open("r1", 1));
      yield* live.start(turn("r2", 2_000));
      yield* live.start(turn("gone", 1_500));
      yield* live.end(ended("gone"));

      const connected = yield* Stream.runCollect(Stream.take(live.events, 2));

      expect([...connected]).toEqual([
        {
          event: "turn.started",
          data: { ...turn("r1"), attempts: [failed("r1", 0), open("r1", 1)] },
        },
        { event: "turn.started", data: turn("r2", 2_000) },
      ]);
    }).pipe(Effect.provide(LiveTurns.layer)),
);

it.effect("shows an attempt's latest state once, in its place", () =>
  Effect.gen(function* () {
    const live = yield* LiveTurns;
    yield* live.start(turn("r1"));
    yield* live.attempt(open("r1", 0));
    yield* live.attempt(failed("r1", 0));

    const [connected] = yield* Stream.runCollect(Stream.take(live.events, 1));

    expect(connected?.data).toEqual({ ...turn("r1"), attempts: [failed("r1", 0)] });
  }).pipe(Effect.provide(LiveTurns.layer)),
);

it.effect("sends nothing about a turn it never showed or already forgot", () =>
  Effect.gen(function* () {
    const live = yield* LiveTurns;
    yield* live.start(turn("r0"));
    const events = yield* listen(live, "r0");

    yield* live.attempt(open("unknown", 0));
    yield* live.end(ended("unknown"));
    yield* live.end(ended("r0"));
    yield* live.end(ended("r0"));
    yield* live.attempt(open("r0", 0));

    expect(yield* take(events, 1)).toEqual([{ event: "turn.ended", data: ended("r0") }]);
    expect(yield* Queue.size(events)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(LiveTurns.layer)),
);

it.effect("keeps at most a thousand turns in flight, leaving out those past it", () =>
  Effect.gen(function* () {
    const live = yield* LiveTurns;

    for (let request = 0; request < 1_001; request++) {
      yield* live.start(turn(`r${request}`, request));
    }

    const events = yield* listen(live, "r0");
    yield* live.attempt(open("r1000", 0));
    yield* live.end(ended("r1000"));

    yield* take(events, 999);
    expect(yield* Queue.size(events)).toBe(0);

    // Once one ends, there is room for another.
    yield* live.end(ended("r0"));
    yield* live.start(turn("r1001"));
    expect((yield* take(events, 2)).map(({ event }) => event)).toEqual([
      "turn.ended",
      "turn.started",
    ]);
  }).pipe(Effect.scoped, Effect.provide(LiveTurns.layer)),
);

const Step = Schema.Struct({
  kind: Schema.Literals(["start", "attempt", "end"]),
  request: Schema.Literals(["r0", "r1", "r2", "r3"]),
});

const steps = Arbitrary.array(Arbitrary.schema(Step), { maxLength: 20 });

it.effect.prop(
  "a listener that connects finds every turn started and not yet ended, and no other",
  { steps },
  ({ steps: values }) =>
    Effect.gen(function* () {
      const live = yield* LiveTurns;
      const inFlight = new Set<string>();

      for (const [at, { kind, request }] of values.entries()) {
        switch (kind) {
          case "start":
            yield* live.start(turn(request, at));
            inFlight.add(request);
            break;
          case "attempt":
            yield* live.attempt(open(request, at));
            break;
          case "end":
            yield* live.end(ended(request));
            inFlight.delete(request);
            break;
        }
      }

      const connected = yield* Stream.runCollect(Stream.take(live.events, inFlight.size));

      expect(connected.map(({ event }) => event)).toEqual(
        Array.from(inFlight, () => "turn.started"),
      );
      expect(
        new Set(connected.map(({ data }) => ("requestId" in data ? data.requestId : ""))),
      ).toEqual(inFlight);
    }).pipe(Effect.provide(LiveTurns.layer)),
);

it.effect("never waits on a listener that falls behind", () =>
  Effect.gen(function* () {
    const live = yield* LiveTurns;
    yield* live.start(turn("r0"));
    // A listener that takes the first event and then never another.
    const stuck = yield* Queue.bounded<TurnEvent>(1);
    yield* Effect.forkScoped(Stream.runForEach(live.events, (event) => Queue.offer(stuck, event)));
    yield* Queue.take(stuck);

    for (let request = 1; request <= 5_000; request++) {
      yield* live.start(turn(`r${request}`));
      yield* live.end(ended(`r${request}`));
    }

    expect(yield* Stream.runCollect(Stream.take(live.events, 1))).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(LiveTurns.layer)),
);
