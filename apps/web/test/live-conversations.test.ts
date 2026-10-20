import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { ancestry, joining } from "../src/lib/live-conversations.ts";

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
