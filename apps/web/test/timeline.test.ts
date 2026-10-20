import { Option } from "effect";
import { describe, expect, it } from "vitest";
import type { LiveAttempt, LiveTurn, TurnAttempt } from "../src/api/types.ts";
import { type TimelineItem, timelineOf } from "../src/lib/timeline.ts";
import { request } from "../src/testing/history.ts";

const T0 = Date.parse("2026-09-27T11:00:00.000Z");

const turn = (
  requestId: string,
  at: number,
  conversation = "root",
  fields: Partial<Parameters<typeof request>[0]> = {},
) =>
  request({
    requestId,
    at: T0 + at,
    durationMs: 1_000,
    firstChunkMs: Option.some(250),
    conversationId: Option.some(conversation),
    ...fields,
  });

const sub = (requestId: string, at: number, id: string, parent: string, agentType?: string) =>
  turn(requestId, at, id, {
    parentConversationId: Option.some(parent),
    agentType: Option.fromNullishOr(agentType),
  });

/** An upstream attempt of `requestId` that failed, from `start` (after T0) for `durationMs`. */
const attempt = (
  requestId: string,
  seq: number,
  start: number,
  durationMs: number,
  fields: Partial<TurnAttempt> = {},
): TurnAttempt => ({
  requestId,
  seq,
  startedAt: T0 + start,
  durationMs,
  firstChunkMs: Option.none(),
  provider: "codex",
  model: "gpt-6-astra",
  accountId: Option.none(),
  accountLabel: Option.none(),
  status: Option.some(429),
  outcome: "failed",
  category: Option.some("rate_limited"),
  upstreamCode: Option.none(),
  downstreamProvider: Option.none(),
  message: Option.none(),
  ...fields,
});

/** An attempt still under way, from `start` (after T0). */
const open = (
  requestId: string,
  seq: number,
  start: number,
  firstChunkMs: Option.Option<number>,
): LiveAttempt => ({
  state: "open",
  requestId,
  seq,
  startedAt: T0 + start,
  provider: "codex",
  model: "gpt-6-astra",
  accountId: Option.none(),
  accountLabel: Option.none(),
  status: Option.some(200),
  firstChunkMs,
});

/** A turn in flight, come in `at` after T0. */
const live = (
  requestId: string,
  at: number,
  conversation: string,
  attempts: ReadonlyArray<LiveAttempt>,
  parent?: string,
): LiveTurn => ({
  requestId,
  at: T0 + at,
  model: "gpt-6-astra",
  conversationId: Option.some(conversation),
  parentConversationId: Option.fromNullishOr(parent),
  agentType: Option.none(),
  client: Option.none(),
  keyName: Option.none(),
  attempts,
});

/** The items in outline: a turn's id, or a sub-agent's id and type around its items. */
const outline = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<unknown> =>
  items.map((item) =>
    item.kind === "turn"
      ? item.turn.requestId
      : { agent: item.id, type: Option.getOrNull(item.agentType), items: outline(item.items) },
  );

/** The turns' numbers, down the rows. */
const numbers = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<number> =>
  items.flatMap((item) => (item.kind === "turn" ? [item.number] : numbers(item.items)));

describe("timelineOf", () => {
  it("spans the conversation from its first turn to the end of its last", () => {
    const timeline = timelineOf("root", [turn("a", 0), turn("b", 9_000)]);

    expect(timeline.from).toBe(T0);
    expect(timeline.to).toBe(T0 + 10_000);
  });

  it("places each turn and its first chunk as shares of the span", () => {
    const [first, second] = timelineOf("root", [turn("a", 0), turn("b", 9_000)]).items;

    expect(first).toMatchObject({ kind: "turn", number: 1, start: 0, end: 0.1 });
    expect(first?.kind === "turn" && first.firstChunk).toEqual(Option.some(0.025));
    expect(second).toMatchObject({ kind: "turn", number: 2, start: 0.9, end: 1 });
  });

  it("nests a sub-agent's turns under its parent, where they started", () => {
    const timeline = timelineOf("root", [
      turn("a", 0),
      sub("s1", 2_000, "root:agent-1", "root", "Explore"),
      turn("b", 3_000),
      sub("s2", 4_000, "root:agent-1", "root", "Explore"),
      sub("n1", 4_500, "nested", "root:agent-1"),
      turn("c", 9_000),
    ]);

    expect(outline(timeline.items)).toEqual([
      "a",
      {
        agent: "root:agent-1",
        type: "Explore",
        items: ["s1", "s2", { agent: "nested", type: null, items: ["n1"] }],
      },
      "b",
      "c",
    ]);
  });

  it("numbers the turns in the order they came, whichever row they sit on", () => {
    const timeline = timelineOf("root", [
      turn("a", 0),
      sub("s1", 2_000, "child", "root"),
      turn("b", 3_000),
    ]);

    expect(numbers(timeline.items)).toEqual([1, 2, 3]);
  });

  it("keeps a sub-agent whose parent left no turns under the conversation itself", () => {
    const timeline = timelineOf("root", [turn("a", 0), sub("s1", 2_000, "child", "gone")]);

    expect(outline(timeline.items)).toEqual(["a", { agent: "child", type: null, items: ["s1"] }]);
  });

  it("keeps sub-agents that name each other as parent under the conversation itself", () => {
    const timeline = timelineOf("root", [
      turn("a", 0),
      sub("x1", 1_000, "x", "y"),
      sub("y1", 2_000, "y", "x"),
    ]);

    expect(outline(timeline.items)).toEqual([
      "a",
      { agent: "x", type: null, items: ["x1"] },
      { agent: "y", type: null, items: ["y1"] },
    ]);
  });

  it("gives a conversation of one instant a span to draw it in", () => {
    const timeline = timelineOf("root", [turn("a", 0, "root", { durationMs: 0 })]);

    expect(timeline.items[0]).toMatchObject({ start: 0, end: 0 });
    expect(timeline.to).toBeGreaterThan(timeline.from);
  });

  it("places each turn's upstream attempts on the same axis, in order", () => {
    const [first, second] = timelineOf("root", [turn("a", 0), turn("b", 9_000)], {
      attempts: [
        attempt("b", 0, 9_000, 500, { outcome: "served" }),
        attempt("a", 1, 400, 600, { outcome: "served", firstChunkMs: Option.some(100) }),
        attempt("a", 0, 0, 400),
      ],
    }).items;

    expect(first?.kind === "turn" && first.attempts).toEqual([
      expect.objectContaining({ open: false, start: 0, end: 0.04, firstChunk: Option.none() }),
      expect.objectContaining({
        open: false,
        start: 0.04,
        end: 0.1,
        firstChunk: Option.some(0.05),
      }),
    ]);
    expect(second?.kind === "turn" && second.attempts.map(({ start }) => start)).toEqual([0.9]);
  });

  it("gives a turn kept before attempts were no attempts", () => {
    const [first] = timelineOf("root", [turn("a", 0)]).items;

    expect(first?.kind === "turn" && first.attempts).toEqual([]);
  });

  it("draws a turn in flight up to now, its open attempt with it, and stretches the axis to now", () => {
    const timeline = timelineOf("root", [turn("a", 0)], {
      live: [
        live("l", 2_000, "root", [
          { ...attempt("l", 0, 2_000, 1_000), state: "ended" },
          open("l", 1, 3_000, Option.some(1_000)),
        ]),
      ],
      now: T0 + 10_000,
    });

    expect(timeline.to).toBe(T0 + 10_000);

    const [, row] = timeline.items;

    expect(row).toMatchObject({ kind: "turn", live: true, number: 2, start: 0.2, end: 1 });
    expect(row?.kind === "turn" && row.firstChunk).toEqual(Option.some(0.4));
    expect(row?.kind === "turn" && row.attempts).toEqual([
      expect.objectContaining({ open: false, start: 0.2, end: 0.3 }),
      expect.objectContaining({ open: true, start: 0.3, end: 1, firstChunk: Option.some(0.4) }),
    ]);
  });

  it("nests a sub-agent's turn in flight under its parent", () => {
    const timeline = timelineOf("root", [turn("a", 0)], {
      live: [live("l", 2_000, "child", [], "root")],
      now: T0 + 4_000,
    });

    expect(outline(timeline.items)).toEqual(["a", { agent: "child", type: null, items: ["l"] }]);
  });
});
