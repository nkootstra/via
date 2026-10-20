import { Option } from "effect";
import { describe, expect, it } from "vitest";
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

/** The items' shape: a turn's id, or a sub-agent's id and type around its items. */
const shape = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<unknown> =>
  items.map((item) =>
    item.kind === "turn"
      ? item.turn.requestId
      : { agent: item.id, type: Option.getOrNull(item.agentType), items: shape(item.items) },
  );

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

    expect(shape(timeline.items)).toEqual([
      "a",
      { agent: "root:agent-1", type: "Explore", items: ["s1", "s2", { agent: "nested", type: null, items: ["n1"] }] },
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

    const numbers = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<number> =>
      items.flatMap((item) => (item.kind === "turn" ? [item.number] : numbers(item.items)));

    expect(numbers(timeline.items)).toEqual([1, 2, 3]);
  });

  it("keeps a sub-agent whose parent left no turns under the conversation itself", () => {
    const timeline = timelineOf("root", [turn("a", 0), sub("s1", 2_000, "child", "gone")]);

    expect(shape(timeline.items)).toEqual(["a", { agent: "child", type: null, items: ["s1"] }]);
  });

  it("keeps sub-agents that name each other as parent under the conversation itself", () => {
    const timeline = timelineOf("root", [
      turn("a", 0),
      sub("x1", 1_000, "x", "y"),
      sub("y1", 2_000, "y", "x"),
    ]);

    expect(shape(timeline.items)).toEqual([
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
});
