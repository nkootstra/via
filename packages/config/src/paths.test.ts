import { describe, expect, it } from "@effect/vitest";
import { resolvePaths } from "./index.ts";

describe("resolvePaths", () => {
  it("uses VIA_HOME when set", () => {
    expect(resolvePaths({ VIA_HOME: "/tmp/via-test" }, "/home/me")).toEqual({
      home: "/tmp/via-test",
      config: "/tmp/via-test/config.yaml",
      keys: "/tmp/via-test/keys.json",
      authDir: "/tmp/via-test/auth",
      state: "/tmp/via-test/state.json",
    });
  });

  it("defaults to .config/via under the user's home directory", () => {
    expect(resolvePaths({}, "/home/me").home).toBe("/home/me/.config/via");
  });
});
