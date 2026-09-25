/** The events that end a Codex Responses stream; nothing meaningful follows them. */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);
