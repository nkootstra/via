import { describe, expect, it } from "@effect/vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "./index.ts";

describe("resolvePaths", () => {
  it("uses VIA_HOME when set", () => {
    expect(resolvePaths({ VIA_HOME: "/tmp/via-test" })).toEqual({
      home: "/tmp/via-test",
      config: "/tmp/via-test/config.yaml",
      keys: "/tmp/via-test/keys.json",
      authDir: "/tmp/via-test/auth",
      state: "/tmp/via-test/state.json",
    });
  });

  it("defaults to ~/.config/via", () => {
    expect(resolvePaths({}).home).toBe(join(homedir(), ".config", "via"));
  });
});
