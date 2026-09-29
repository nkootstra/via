import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import { upstreamErrorOf } from "./upstream-error.ts";

describe("upstreamErrorOf", () => {
  it("reads OpenCode Go's error: its type as the code", () => {
    expect(
      upstreamErrorOf(
        '{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}',
      ),
    ).toEqual({
      code: Option.some("ModelProtocolUnsupported"),
      message: Option.some("Model does not support this protocol."),
    });
  });

  it("reads an OpenAI-style error, preferring its code to its type", () => {
    expect(
      upstreamErrorOf(
        '{"error":{"message":"No such model","type":"invalid_request_error","code":"model_not_found"}}',
      ),
    ).toEqual({ code: Option.some("model_not_found"), message: Option.some("No such model") });

    expect(
      upstreamErrorOf('{"error":{"message":"Slow down","type":"rate_limit_error","code":null}}'),
    ).toEqual({ code: Option.some("rate_limit_error"), message: Option.some("Slow down") });
  });

  it("reads Codex's error, which has only a detail", () => {
    expect(upstreamErrorOf('{"detail":"Input must be a list"}')).toEqual({
      code: Option.none(),
      message: Option.some("Input must be a list"),
    });
  });

  it("keeps a body that isn't JSON as the message, cut to 500 characters", () => {
    expect(upstreamErrorOf("  Bad Gateway\n")).toEqual({
      code: Option.none(),
      message: Option.some("Bad Gateway"),
    });

    expect(Option.getOrElse(upstreamErrorOf("x".repeat(2_000)).message, () => "")).toHaveLength(
      500,
    );
  });

  it("says nothing for an empty body", () => {
    expect(upstreamErrorOf(" ")).toEqual({ code: Option.none(), message: Option.none() });
  });
});
