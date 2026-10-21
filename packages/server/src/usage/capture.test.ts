import { describe, expect, it } from "@effect/vitest";
import type { UsageEntry } from "@via/usage";
import { Option } from "effect";
import { refusalOf } from "../proxy/upstream-error.ts";
import { captureOf, worthCapturing } from "./capture.ts";

const turn = (fields: Partial<UsageEntry>) =>
  ({
    status: 200,
    streamEnd: Option.none(),
    requestedModel: Option.none(),
    ...fields,
  }) satisfies Pick<UsageEntry, "status" | "streamEnd" | "requestedModel">;

describe("worthCapturing", () => {
  it("captures a failed turn, a broken-off stream and a fallback, not one that went well", () => {
    expect(worthCapturing(turn({ status: 429 }))).toBe(true);
    expect(worthCapturing(turn({ streamEnd: Option.some("failed") }))).toBe(true);
    expect(worthCapturing(turn({ requestedModel: Option.some("gpt-x") }))).toBe(true);
    expect(worthCapturing(turn({}))).toBe(false);
    expect(worthCapturing(turn({ streamEnd: Option.some("completed") }))).toBe(false);
  });

  it("doesn't capture a turn its client gave up on", () => {
    expect(worthCapturing(turn({ status: 499 }))).toBe(false);
  });
});

describe("captureOf", () => {
  it("keeps an error body that isn't JSON as its text, and one with no status as such", () => {
    const captured = captureOf("r1", 5, "responses", { input: "hi" }, [
      { seq: 0, status: Option.none(), body: "upstream connect error" },
      { seq: 2, status: Option.some(400), body: '{"error":{"message":"bad"}}' },
    ]);

    expect(captured).toEqual({
      requestId: "r1",
      capturedAt: 5,
      endpoint: "responses",
      request: { input: "hi" },
      upstreamErrors: [
        { seq: 0, status: null, body: "upstream connect error" },
        { seq: 2, status: 400, body: { error: { message: "bad" } } },
      ],
      redactions: [],
      truncated: false,
      sizeBytes: 14,
    });
  });

  it("cuts a request over 4 MB to fit, and says so", () => {
    const captured = captureOf(
      "r1",
      5,
      "chat/completions",
      { messages: [{ role: "user", content: "a b ".repeat(1_500_000) }] },
      [],
    );

    expect(captured.truncated).toBe(true);
    expect(captured.sizeBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(captured.request).toMatchObject({ messages: [{ role: "user" }] });
  });

  it("never keeps a private key an error body was cut off in the middle of", () => {
    const key = "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB";

    const answer = JSON.stringify({
      error: {
        message: `bad request: -----BEGIN RSA PRIVATE KEY-----\n${key.repeat(2_000)}\n-----END RSA PRIVATE KEY-----`,
      },
    });

    // Cut to 64 KiB, as via keeps an error answer, which leaves the key with no END line.
    const kept = refusalOf(answer).body ?? "";

    const captured = captureOf("r1", 5, "responses", { input: "hi" }, [
      { seq: 0, status: Option.some(400), body: kept },
    ]);

    expect(JSON.stringify(captured)).not.toContain(key.slice(0, 16));
  });
});
