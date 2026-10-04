import { describe, expect, it } from "@effect/vitest";
import { modelIds, resolveAlias } from "./models.ts";

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

  it("leaves a model the catalog lists by its whole name alone, though it ends in an effort", () => {
    const catalog = [{ model: "gpt-7-codex-max", efforts: ["high"] }];
    expect(resolveAlias("gpt-7-codex-max", catalog)).toEqual({ model: "gpt-7-codex-max" });
    expect(resolveAlias("gpt-7-codex-max-high", catalog)).toEqual({
      model: "gpt-7-codex-max",
      effort: "high",
    });
  });

  it("lists a catalog Codex served, aliasing only the efforts via can resolve", () => {
    expect(
      modelIds([
        { model: "gpt-7", efforts: ["low", "turbo"] },
        { model: "gpt-7-mini", efforts: [] },
      ]),
    ).toEqual(["gpt-7", "gpt-7-mini", "gpt-7-low"]);
  });
});
