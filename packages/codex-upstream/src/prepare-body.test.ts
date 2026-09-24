import { describe, expect, it } from "@effect/vitest";
import { prepareBody } from "./index.ts";

const request = { model: "gpt-6-astra", input: "hi" };

describe("prepareBody", () => {
  it("always streams and never stores, because the Codex backend only allows that", () => {
    expect(prepareBody({ ...request, stream: false, store: true })).toMatchObject({
      stream: true,
      store: false,
    });
  });

  it("asks for encrypted reasoning so later turns can reuse it without storage", () => {
    expect(prepareBody(request).include).toEqual(["reasoning.encrypted_content"]);
  });

  it("keeps the client's include entries", () => {
    expect(prepareBody({ ...request, include: ["message.output_text.logprobs"] }).include).toEqual([
      "message.output_text.logprobs",
      "reasoning.encrypted_content",
    ]);
  });

  it('defaults instructions to "" to avoid "Instructions are required"', () => {
    expect(prepareBody(request).instructions).toBe("");
    expect(prepareBody({ ...request, instructions: "Be brief." }).instructions).toBe("Be brief.");
  });

  for (const parameter of ["max_output_tokens", "temperature", "top_p", "previous_response_id"]) {
    it(`drops ${parameter} to avoid "Unsupported parameter: ${parameter}"`, () => {
      expect(prepareBody({ ...request, [parameter]: 1 })).not.toHaveProperty(parameter);
    });
  }

  it("passes everything else through", () => {
    const tools = [{ type: "function", name: "lookup", parameters: {} }];
    expect(prepareBody({ ...request, tools, reasoning: { effort: "high" } })).toMatchObject({
      ...request,
      tools,
      reasoning: { effort: "high" },
    });
  });

  it("turns an effort suffix alias into the base model and a reasoning effort", () => {
    expect(
      prepareBody({ ...request, model: "gpt-6-astra-high", reasoning: { summary: "auto" } }),
    ).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "high", summary: "auto" } });
  });

  it("leaves a model without an effort suffix alone", () => {
    expect(prepareBody({ ...request, model: "gpt-5.4-mini" })).toMatchObject({
      model: "gpt-5.4-mini",
    });
    expect(prepareBody(request)).not.toHaveProperty("reasoning");
  });
});
