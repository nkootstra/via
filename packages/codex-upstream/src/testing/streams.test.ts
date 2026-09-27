import { describe, expect, it } from "@effect/vitest";
import { sse, sseFrames } from "./streams.ts";

describe("sseFrames", () => {
  it("splits a Responses stream into its named events", () => {
    const created = { type: "response.created", response: { id: "resp_1" } };

    expect(sseFrames(sse([created, { type: "response.completed" }]))).toEqual([
      { event: "response.created", data: JSON.stringify(created) },
      { event: "response.completed", data: '{"type":"response.completed"}' },
    ]);
  });

  it("reads a Chat Completions stream, whose frames carry only data", () => {
    expect(sseFrames('data: {"choices":[]}\n\ndata: [DONE]\n\n')).toEqual([
      { event: undefined, data: '{"choices":[]}' },
      { event: undefined, data: "[DONE]" },
    ]);
  });
});
