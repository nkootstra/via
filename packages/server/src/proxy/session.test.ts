import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { resolveConversation, resolveSession } from "./session.ts";

const chat = (...messages: ReadonlyArray<{ role: string; content: Schema.Json }>) => ({
  model: "m",
  messages,
});

const subAgent = (id: string) => ({ "x-session-id": id, "x-parent-session-id": "ses_parent" });

describe("resolveSession", () => {
  it("takes the first session id a client sent, in order of precedence", () => {
    const all = {
      "x-parent-session-id": "parent",
      "x-opencode-session-id": "opencode",
      "x-opencode-session": "opencode-old",
      "x-claude-code-session-id": "claude",
      "session-id": "codex",
      session_id: "cline",
      "thread-id": "thread",
      "x-session-id": "generic",
      "x-task-id": "task",
      "x-kilocode-taskid": "kilo",
    };

    const body = { session_id: "body", prompt_cache_key: "cache" };

    const order = [
      ["x-parent-session-id", "parent"],
      ["x-opencode-session-id", "opencode"],
      ["x-opencode-session", "opencode-old"],
      ["x-claude-code-session-id", "claude"],
      ["session-id", "codex"],
      ["session_id", "cline"],
      ["thread-id", "thread"],
      ["x-session-id", "generic"],
      ["body session_id", "body"],
      ["body prompt_cache_key", "cache"],
      ["x-task-id", "task"],
      ["x-kilocode-taskid", "kilo"],
    ] as const;

    const headers: Partial<typeof all> = { ...all };
    const remaining: Partial<typeof body> = { ...body };

    for (const [source, id] of order) {
      expect(resolveSession(headers, remaining), source).toBe(id);

      if (source === "body session_id") delete remaining["session_id"];
      else if (source === "body prompt_cache_key") delete remaining["prompt_cache_key"];
      else delete headers[source];
    }
  });

  it("gives OpenCode's sub-agents their parent's session, so they share one prompt cache", () => {
    expect(resolveSession(subAgent("ses_child1"), {})).toBe("ses_parent");
    expect(resolveSession(subAgent("ses_child2"), {})).toBe("ses_parent");
    expect(resolveSession({ "x-session-id": "ses_parent" }, {})).toBe("ses_parent");
  });

  it("gives every turn of one chat the same id and other chats another", () => {
    const system = { role: "system", content: "Be brief." };
    const first = { role: "user", content: "Hi" };
    const turn1 = resolveSession({}, chat(system, first));

    const turn2 = resolveSession(
      {},
      chat(
        system,
        first,
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Bye" },
      ),
    );

    const other = resolveSession({}, chat(system, { role: "user", content: "Hey" }));
    expect(turn2).toBe(turn1);
    expect(other).not.toBe(turn1);
    expect(turn1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives a Responses conversation's id from its instructions and first input", () => {
    const first = { role: "user", content: "Hi" };
    const turn1 = resolveSession({}, { instructions: "Be brief.", input: [first] });

    const turn2 = resolveSession(
      {},
      { instructions: "Be brief.", input: [first, { role: "user", content: "Bye" }] },
    );

    expect(turn2).toBe(turn1);
    expect(resolveSession({}, { instructions: "Be long.", input: [first] })).not.toBe(turn1);
    expect(resolveSession({}, { input: "Hi" })).not.toBe(resolveSession({}, { input: "Hey" }));
  });

  it("hashes an id too long for providers to accept", () => {
    const id = resolveSession({ "x-session-id": "x".repeat(257) }, {});
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveSession({ "x-session-id": "x".repeat(256) }, {})).toBe("x".repeat(256));
  });

  it("ignores empty and non-string ids", () => {
    expect(
      resolveSession({ "x-opencode-session": "" }, { session_id: 7, prompt_cache_key: "k" }),
    ).toBe("k");
  });
});

const conversation = (headers: Readonly<Record<string, string>>, body: Schema.JsonObject = {}) =>
  resolveConversation(headers, body);

describe("resolveConversation", () => {
  it("names an OpenCode session by its own id, under its parent's", () => {
    expect(
      conversation({ "x-opencode-session-id": "ses_root", "x-session-id": "ses_root" }),
    ).toEqual({
      conversationId: "ses_root",
      parentConversationId: Option.none(),
      source: "x-opencode-session-id",
      agentType: Option.none(),
    });

    expect(
      conversation({
        "x-opencode-session-id": "ses_child",
        "x-opencode-parent-session-id": "ses_root",
        "x-parent-session-id": "ses_root",
      }),
    ).toMatchObject({ conversationId: "ses_child", parentConversationId: Option.some("ses_root") });

    // To other providers OpenCode sends only the generic headers.
    expect(
      conversation({ "x-session-id": "ses_child", "x-parent-session-id": "ses_root" }),
    ).toMatchObject({
      conversationId: "ses_child",
      parentConversationId: Option.some("ses_root"),
      source: "x-session-id",
    });
  });

  it("names a Codex thread by its thread id, a sub-agent's under its parent thread", () => {
    expect(conversation({ "session-id": "s1", "thread-id": "t1" })).toEqual({
      conversationId: "t1",
      parentConversationId: Option.none(),
      source: "thread-id",
      agentType: Option.none(),
    });

    expect(
      conversation({
        "session-id": "s1",
        "thread-id": "t2",
        "x-codex-parent-thread-id": "t1",
        "x-openai-subagent": "review",
      }),
    ).toEqual({
      conversationId: "t2",
      parentConversationId: Option.some("t1"),
      source: "thread-id",
      agentType: Option.some("review"),
    });

    expect(
      conversation({}, { client_metadata: { session_id: "s1", thread_id: "t3" } }),
    ).toMatchObject({ conversationId: "t3", source: "body.client_metadata.thread_id" });

    // Older builds sent the conversation as `conversation_id`.
    expect(conversation({ session_id: "s1", conversation_id: "c1" })).toMatchObject({
      conversationId: "c1",
      source: "conversation_id",
    });
  });

  it("names a Claude Code agent within its session, under the agent that started it", () => {
    expect(conversation({ "x-claude-code-session-id": "cc1" })).toEqual({
      conversationId: "cc1",
      parentConversationId: Option.none(),
      source: "x-claude-code-session-id",
      agentType: Option.none(),
    });

    expect(
      conversation({
        "x-claude-code-session-id": "cc1",
        "x-claude-code-agent-id": "a1",
        "x-claude-code-agent-type": "Explore",
      }),
    ).toEqual({
      conversationId: "cc1:a1",
      parentConversationId: Option.some("cc1"),
      source: "x-claude-code-agent-id",
      agentType: Option.some("Explore"),
    });

    expect(
      conversation({
        "x-claude-code-session-id": "cc1",
        "x-claude-code-agent-id": "a2",
        "x-claude-code-parent-agent-id": "a1",
      }),
    ).toMatchObject({ conversationId: "cc1:a2", parentConversationId: Option.some("cc1:a1") });
  });

  it("falls back to the other ids clients send, in order", () => {
    expect(conversation({ "x-task-id": "task" }, { prompt_cache_key: "cache" })).toMatchObject({
      conversationId: "cache",
      source: "body.prompt_cache_key",
    });

    expect(conversation({ "x-kilocode-taskid": "kilo" })).toMatchObject({
      conversationId: "kilo",
      source: "x-kilocode-taskid",
    });
  });

  it("guesses a conversation without an id from its opening, as the routing key does", () => {
    const body = chat({ role: "system", content: "Be brief." }, { role: "user", content: "Hi" });

    expect(conversation({}, body)).toEqual({
      conversationId: resolveSession({}, body),
      parentConversationId: Option.none(),
      source: "hash",
      agentType: Option.none(),
    });
  });

  it("never makes a conversation its own parent", () => {
    expect(conversation({ "x-session-id": "ses_1", "x-parent-session-id": "ses_1" })).toMatchObject(
      { conversationId: "ses_1", parentConversationId: Option.none() },
    );
  });

  it("hashes an id too long to look up, the same way wherever it appears", () => {
    const long = "x".repeat(101);
    const parent = conversation({ "x-session-id": long });
    const child = conversation({ "x-session-id": "ses_2", "x-parent-session-id": long });

    expect(parent.conversationId).toMatch(/^[0-9a-f]{64}$/);
    expect(child.parentConversationId).toEqual(Option.some(parent.conversationId));
  });

  const Ids = Schema.Record(
    Schema.Literals([
      "x-opencode-session-id",
      "x-opencode-parent-session-id",
      "x-parent-session-id",
      "x-session-id",
      "thread-id",
      "session-id",
      "x-codex-parent-thread-id",
      "x-openai-subagent",
      "x-claude-code-session-id",
      "x-claude-code-agent-id",
      "x-claude-code-parent-agent-id",
      "x-claude-code-agent-type",
      "x-task-id",
    ]),
    Schema.String,
  );

  it.prop(
    "always names a conversation, short enough to look up, and never its own parent",
    { headers: Ids, cacheKey: Schema.optional(Schema.String) },
    ({ headers, cacheKey }) => {
      const found = conversation(
        headers,
        cacheKey === undefined ? {} : { prompt_cache_key: cacheKey },
      );

      return (
        found.conversationId.length > 0 &&
        found.conversationId.length <= 100 &&
        found.source.length > 0 &&
        Option.match(found.parentConversationId, {
          onNone: () => true,
          onSome: (id) => id.length > 0 && id.length <= 100 && id !== found.conversationId,
        }) &&
        Option.match(found.agentType, {
          onNone: () => true,
          onSome: (type) => type.length > 0 && type.length <= 64,
        })
      );
    },
  );
});
