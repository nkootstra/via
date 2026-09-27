import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { resolveSession } from "./session.ts";

const chat = (...messages: ReadonlyArray<{ role: string; content: Schema.Json }>) => ({
  model: "m",
  messages,
});

const subAgent = (id: string) => ({ "x-session-id": id, "x-parent-session-id": "ses_parent" });

describe("resolveSession", () => {
  it("takes the first session id a client sent, in order of precedence", () => {
    const all = {
      "x-parent-session-id": "parent",
      "x-opencode-session": "opencode",
      "x-claude-code-session-id": "claude",
      "session-id": "codex",
      session_id: "cline",
      "x-session-id": "generic",
      "x-task-id": "task",
      "x-kilocode-taskid": "kilo",
    };

    const body = { session_id: "body", prompt_cache_key: "cache" };

    const order = [
      ["x-parent-session-id", "parent"],
      ["x-opencode-session", "opencode"],
      ["x-claude-code-session-id", "claude"],
      ["session-id", "codex"],
      ["session_id", "cline"],
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

  it("gives opencode's sub-agents their parent's session, so they share one prompt cache", () => {
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
