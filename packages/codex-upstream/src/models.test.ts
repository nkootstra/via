import { describe, expect, it } from "@effect/vitest";
import { modelIds, resolveAlias } from "./index.ts";

describe("the model catalog", () => {
  it("lists the models ChatGPT sign-in serves today", () => {
    expect(modelIds().filter((id) => resolveAlias(id).effort === undefined)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
  });

  it("offers only the efforts each model supports", () => {
    const ids = modelIds();
    expect(ids).toContain("gpt-6-astra-ultra");
    expect(ids).toContain("gpt-6-sol-none");
    expect(ids).toContain("gpt-6-luna-max");
    expect(ids).not.toContain("gpt-6-astra-none");
    expect(ids).not.toContain("gpt-6-luna-ultra");
  });

  it.each([
    ["gpt-6-sol-none", "gpt-6-sol", "none"],
    ["gpt-6-astra-max", "gpt-6-astra", "max"],
    ["gpt-6-astra-ultra", "gpt-6-astra", "ultra"],
  ])("resolves %s to %s at %s effort", (alias, model, effort) => {
    expect(resolveAlias(alias)).toEqual({ model, effort });
  });
});
