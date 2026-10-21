import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { harnessName } from "../src/lib/harness.ts";

describe("harnessName", () => {
  it.each([
    ["opencode/1.19.3", "OpenCode 1.19.3"],
    ["codex_cli_rs/0.40.0", "Codex 0.40.0"],
    ["codex_exec/0.41.0", "Codex 0.41.0"],
    ["claude-cli/2.0.14", "Claude Code 2.0.14"],
    ["Roo Code", "Roo Code"],
    ["aider/0.86.1", "Aider 0.86.1"],
  ])("names %s as its maker does, with its version", (client, name) => {
    expect(harnessName(Option.some(client), "x-session-id")).toBe(name);
  });

  it("names a harness it doesn't know as its User-Agent does", () => {
    expect(harnessName(Option.some("my-agent/2.1"), "x-session-id")).toBe("my-agent 2.1");
  });

  it.each([
    ["x-opencode-session-id", "OpenCode"],
    ["x-claude-code-session-id", "Claude Code"],
    ["x-claude-code-agent-id", "Claude Code"],
    ["thread-id", "Codex"],
    ["body.client_metadata.thread_id", "Codex"],
    ["x-kilocode-taskid", "Kilo Code"],
  ])("tells the harness by the id it sent (%s) when it sent no User-Agent", (source, name) => {
    expect(harnessName(Option.none(), source)).toBe(name);
  });

  it("says so when nothing tells the harness", () => {
    expect(harnessName(Option.none(), "hash")).toBe("Unknown client");
    expect(harnessName(Option.none(), "x-session-id")).toBe("Unknown client");
  });
});
