import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { ancestry, joining, unlisted, unresolved } from "../src/lib/live-conversations.ts";
import { liveTurn, request } from "../src/testing/history.ts";

/** A turn of `conversation`, started by `parent` when it's a sub-agent's. */
const turn = (requestId: string, conversation?: string, parent?: string) => ({
  requestId,
  conversationId: Option.fromNullishOr(conversation),
  parentConversationId: Option.fromNullishOr(parent),
});

const ids = (turns: ReadonlyArray<{ readonly requestId: string }>) =>
  turns.map(({ requestId }) => requestId);

describe("joining", () => {
  it("takes the turns of the conversation, of its sub-agents, and of theirs, at any depth", () => {
    const kept = [turn("a", "root"), turn("s", "root:sub", "root")];

    expect(
      ids(
        joining("root", kept, [
          turn("l1", "root"),
          turn("l2", "root:sub"),
          // Its parent is new too, and comes after it.
          turn("l3", "deep", "root:new"),
          turn("l4", "root:new", "root"),
          turn("x", "other"),
          turn("y", "other:sub", "other"),
          turn("z"),
        ]),
      ),
    ).toEqual(["l1", "l2", "l3", "l4"]);
  });

  it("takes a conversation's turns when the history has none of it yet", () => {
    expect(ids(joining("new", [], [turn("l1", "new"), turn("x", "other")]))).toEqual(["l1"]);
  });
});

describe("ancestry", () => {
  it("names each turn's conversation and those its parents lead up through", () => {
    const chains = ancestry([
      turn("a", "root"),
      turn("b", "root:sub", "root"),
      turn("c", "deep", "root:sub"),
      turn("d", "orphan", "gone"),
    ]);

    expect(chains.get("a")).toEqual(["root"]);
    expect(chains.get("b")).toEqual(["root:sub", "root"]);
    expect(chains.get("c")).toEqual(["deep", "root:sub", "root"]);
    // A parent with no turn here may be a conversation the history has.
    expect(chains.get("d")).toEqual(["orphan", "gone"]);
  });

  it("stops at a circle of parents", () => {
    const chains = ancestry([turn("x", "x", "y"), turn("y", "y", "x")]);

    expect(chains.get("x")).toEqual(["x", "y"]);
    expect(chains.get("y")).toEqual(["y", "x"]);
  });

  it("leaves out a turn of no conversation", () => {
    expect(ancestry([turn("z")]).has("z")).toBe(false);
  });
});

/** A turn in flight of `conversation`, started by `parent`. */
const flying = (requestId: string, conversation: string, parent?: string) =>
  liveTurn({
    requestId,
    conversationId: Option.some(conversation),
    parentConversationId: Option.fromNullishOr(parent),
  });

describe("unlisted", () => {
  it("starts no row for a sub-agent's sub-agent whose parent it can't place", () => {
    const { live, pending } = unlisted(new Set(["root"]), [], [flying("l1", "deep", "root:sub")]);

    expect(pending).toEqual([]);
    expect([...live]).toEqual(["deep", "root:sub"]);
  });

  it("marks the conversation it started from live, once the history places its parent", () => {
    const { live, pending } = unlisted(
      new Set(["root"]),
      [],
      [flying("l1", "deep", "root:sub")],
      [
        request({
          requestId: "s1",
          conversationId: Option.some("root:sub"),
          parentConversationId: Option.some("root"),
        }),
      ],
    );

    expect(pending).toEqual([]);
    expect(live.has("root")).toBe(true);
  });

  it("starts a row for a conversation whose first turn is in flight, its sub-agents' with it", () => {
    const { pending } = unlisted(
      new Set(["root"]),
      [],
      [flying("l1", "new"), flying("l2", "new:sub", "new"), flying("l3", "deep", "new:sub")],
    );

    expect(pending.map(({ id, turns }) => [id, turns])).toEqual([["new", 3]]);
  });
});

describe("unresolved", () => {
  it("names the conversations a turn in flight leads up to whose parents it can't place", () => {
    expect(
      unresolved(
        new Set(["root"]),
        [],
        [
          liveTurn({
            requestId: "l1",
            conversationId: Option.some("deep"),
            parentConversationId: Option.some("root:sub"),
          }),
          liveTurn({
            requestId: "l2",
            conversationId: Option.some("root:other"),
            parentConversationId: Option.some("root"),
          }),
          liveTurn({ requestId: "l3", conversationId: Option.some("new") }),
        ],
      ),
    ).toEqual(["root:sub"]);
  });
});
