import { describe, expect, it } from "vitest";
import { effortHint, problemOf } from "../src/lib/fallbacks.ts";
import { modelEntries } from "../src/lib/model-entries.ts";

const model = (id: string) => ({ id, object: "model", created: 0, owned_by: "via" });

const entries = modelEntries(
  [
    "gpt-5.6-sol",
    "gpt-5.6-sol-low",
    "gpt-5.6-sol-high",
    "gpt-5.5",
    "gpt-5.5-low",
    "gpt-5.5-mini",
    "opencode-go/kimi-k3",
  ].map(model),
);

describe("problemOf", () => {
  it("asks for at least one model to fall back to", () => {
    expect(problemOf("gpt-5.6-sol", [])).toBe("Add at least one model to fall back to");
  });

  it("allows at most three", () => {
    expect(problemOf("gpt-5.6-sol", ["a", "b", "c", "d"])).toBe(
      "A model can fall back to at most 3 others",
    );
  });

  it("names a model listed twice", () => {
    expect(problemOf("gpt-5.6-sol", ["gpt-5.5", "gpt-5.5"])).toBe("gpt-5.5 is in the list twice");
  });

  it("names a model that falls back to itself", () => {
    expect(problemOf("gpt-5.6-sol", ["gpt-5.6-sol"])).toBe("gpt-5.6-sol can't fall back to itself");
  });

  it("finds nothing wrong with a list of others", () => {
    expect(problemOf("gpt-5.6-sol", ["gpt-5.5", "opencode-go/kimi-k3"])).toBeUndefined();
  });
});

describe("effortHint", () => {
  it("says a model without efforts takes a request with one at its default", () => {
    expect(effortHint("gpt-5.6-sol", "opencode-go/kimi-k3", entries)).toBe(
      "kimi-k3 has no reasoning efforts: a request for gpt-5.6-sol-high gets it at its default.",
    );
  });

  it("names an effort the fallback lacks", () => {
    expect(effortHint("gpt-5.6-sol", "gpt-5.5", entries)).toBe(
      "gpt-5.5 has no high effort: a request for gpt-5.6-sol-high gets it at its default.",
    );
  });

  it("says nothing when the fallback has every effort the model has", () => {
    expect(effortHint("gpt-5.5", "gpt-5.6-sol", entries)).toBeUndefined();
  });

  it("says nothing for a model without efforts", () => {
    expect(effortHint("opencode-go/kimi-k3", "gpt-5.5-mini", entries)).toBeUndefined();
  });
});
