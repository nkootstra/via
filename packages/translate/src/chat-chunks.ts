/**
 * The Server-Sent Events of a Chat Completions stream, written the same way
 * whichever upstream API they are translated from.
 */
import type { Schema } from "effect";

// Every chunk shares the envelope, so it is serialized once per response
// rather than spread into and stringified with each chunk.
/** The chunk envelope as JSON, left open for the fields that follow it. */
export const envelope = (id: string, created: number, model: string) =>
  JSON.stringify({ id, object: "chat.completion.chunk", created, model }).slice(0, -1);

/** A chunk of one choice: its `delta` and, on the last, why it finished. */
export const chunk = (envelope_: string, delta: Schema.JsonObject, reason: string | null) =>
  `data: ${envelope_},"choices":[{"index":0,"delta":${JSON.stringify(delta)},"finish_reason":${JSON.stringify(reason)}}]}\n\n`;

/** The chunk with no choices that carries the stream's usage. */
export const usageChunk = (envelope_: string, usage: Schema.Json) =>
  `data: ${envelope_},"choices":[],"usage":${JSON.stringify(usage)}}\n\n`;

// Chat Completions has no failure event; clients such as the openai SDK raise
// an `error` payload sent in place of a chunk.
/** The error payload a stream that failed ends with, instead of `[DONE]`. */
export const failure = (code: string, message: string) =>
  `data: ${JSON.stringify({ error: { message, type: "server_error", code } })}\n\n`;

/** The end of a stream that did not fail. */
export const DONE = "data: [DONE]\n\n";
