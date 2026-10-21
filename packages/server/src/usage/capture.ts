// What via keeps of a turn that failed or fell back, while the setting to keep them is
// on: its request body and every upstream's error answer, redacted, then cut to fit.
import type { CapturedRequest, UsageEntry } from "@via/usage";
import { Option, Schema } from "effect";
import { capped, redact } from "./redact.ts";

/** The most a captured request takes as JSON; a longer one has its long strings cut. */
const MAX_CAPTURED_BYTES = 4 * 1024 * 1024;

/**
 * Whether `entry` is a turn worth capturing: one that failed, as the history counts a
 * failure (an error status other than a client giving up, or a stream that broke off), or
 * one another model answered for the one asked for.
 */
export const worthCapturing = (
  entry: Pick<UsageEntry, "status" | "streamEnd" | "requestedModel">,
) =>
  (entry.status >= 400 && entry.status !== 499) ||
  Option.contains(entry.streamEnd, "failed") ||
  Option.isSome(entry.requestedModel);

/** An upstream attempt's error answer, as the request noted it. */
export interface AttemptAnswer {
  readonly seq: number;
  readonly status: Option.Option<number>;
  readonly body: string;
}

/** An error body as JSON, when it is, else its text. */
const asJson = (body: string): Schema.Json =>
  Option.getOrElse(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(body),
    () => body,
  );

/**
 * Request `requestId`'s capture, taken at `capturedAt`: `request`, the body the client sent
 * to `endpoint`, and `answers`, what each upstream attempt that failed answered, all redacted
 * together, and then the request cut to 4 MB.
 */
export const captureOf = (
  requestId: string,
  capturedAt: number,
  endpoint: CapturedRequest["endpoint"],
  request: Schema.Json,
  answers: ReadonlyArray<AttemptAnswer>,
): CapturedRequest => {
  const { value, redactions } = redact([request, ...answers.map((answer) => asJson(answer.body))]);
  // Redacting keeps array lengths, so what comes out lines up with what went in.
  const [redactedRequest = null, ...bodies] = Array.isArray(value) ? value : [];
  const kept = capped(redactedRequest, MAX_CAPTURED_BYTES);

  return {
    requestId,
    capturedAt,
    endpoint,
    request: kept.value,
    upstreamErrors: answers.map((answer, index) => ({
      seq: answer.seq,
      status: Option.getOrNull(answer.status),
      body: bodies[index] ?? null,
    })),
    redactions,
    truncated: kept.truncated,
    sizeBytes: kept.sizeBytes,
  };
};
