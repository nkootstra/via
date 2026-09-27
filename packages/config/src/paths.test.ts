import { describe, expect, it } from "@effect/vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
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

  it("reads VIA_HOME from the process environment by default", ({ onTestFinished }) => {
    vi.stubEnv("VIA_HOME", "/tmp/via-env");
    // Restore the environment even when the assertion fails, so it can't leak into other tests.
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    expect(resolvePaths().home).toBe("/tmp/via-env");
  });
});
