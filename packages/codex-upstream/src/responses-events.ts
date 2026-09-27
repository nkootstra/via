import { Schema } from "effect";

/** The token counts a Responses `usage` object reports. */
export const ResponsesUsage = Schema.Struct({
  input_tokens: Schema.Finite,
  output_tokens: Schema.Finite,
  // Codex leaves the details out, or sends `null`, when it has none to report.
  input_tokens_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optionalKey(Schema.Finite) })),
  ),
});

/**
 * The event that ends a stream with a finished response. A consumer that
 * reads more of the response than a JSON object narrows `response`.
 */
export const ResponseCompleted = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Schema.JsonObject,
});

/** The event that ends a stream with a response Codex could not produce. */
export const ResponseFailed = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: Schema.Struct({
    error: Schema.Struct({ code: Schema.String, message: Schema.String }),
  }),
});

/** The event that ends a stream with a response cut short, such as by its token limit. */
export const ResponseIncomplete = Schema.Struct({
  type: Schema.Literal("response.incomplete"),
  response: Schema.JsonObject,
});

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  ResponseCompleted.fields.type.literal,
  ResponseFailed.fields.type.literal,
  ResponseIncomplete.fields.type.literal,
]);

/** Whether an event of this type ends a Responses stream; nothing meaningful follows one. */
export const isTerminalEvent = (type: string) => TERMINAL_EVENTS.has(type);

/** What a client is told when a Codex stream breaks off before its terminal event. */
export const streamIncomplete = {
  code: "upstream_incomplete",
  message: "The Codex stream ended before the response completed",
} as const;
