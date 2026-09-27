import { describe, expect, it } from "vitest";
import { providerName } from "../src/lib/provider-name.ts";

describe("providerName", () => {
  it("names OpenCode Go as OpenCode does, not by its id", () => {
    expect(providerName("opencode-go")).toBe("OpenCode Go");
  });

  it("names any other provider by its id", () => {
    expect(providerName("openrouter")).toBe("openrouter");
  });
});
