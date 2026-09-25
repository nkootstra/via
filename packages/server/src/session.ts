import { createHash } from "node:crypto";

type Headers = Readonly<Record<string, string | undefined>>;

// Where coding agents put their conversation id: opencode, Kilo and Hermes
// send `x-opencode-session`; Claude Code `x-claude-code-session-id`; Codex
// `session-id` plus `prompt_cache_key`; Cline and Roo `session_id` on their
// Codex paths and `x-task-id`; opencode `x-session-id` to other providers.
const sources: ReadonlyArray<(headers: Headers, body: Record<string, unknown>) => unknown> = [
  (headers) => headers["x-opencode-session"],
  (headers) => headers["x-claude-code-session-id"],
  (headers) => headers["session-id"],
  (headers) => headers["session_id"],
  (headers) => headers["x-session-id"],
  (_, body) => body["session_id"],
  (_, body) => body["prompt_cache_key"],
  (headers) => headers["x-task-id"],
  (headers) => headers["x-kilocode-taskid"],
];

// OpenRouter caps session ids at 256 characters.
const MAX_LENGTH = 256;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const role = (message: unknown) =>
  typeof message === "object" && message !== null && "role" in message ? message.role : undefined;

/**
 * The start of a conversation, which every later turn repeats: the first
 * system or developer message and the first user message, or for the
 * Responses API the instructions and the first input item.
 */
const opening = (body: Record<string, unknown>) => {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const input = body["input"];
  return Array.isArray(input) || typeof input === "string" || body["instructions"] !== undefined
    ? [body["instructions"], Array.isArray(input) ? input[0] : input]
    : [
        messages.find((message) => role(message) === "system" || role(message) === "developer"),
        messages.find((message) => role(message) === "user"),
      ];
};

/**
 * One id for the conversation a request belongs to, so providers can keep it
 * on a warm prompt cache: the id the client sent, else one derived from the
 * conversation's opening, as OpenRouter does itself.
 */
export const resolveSession = (headers: Headers, body: Record<string, unknown>): string => {
  for (const source of sources) {
    const id = source(headers, body);
    if (typeof id === "string" && id !== "") return id.length > MAX_LENGTH ? sha256(id) : id;
  }
  return sha256(JSON.stringify(opening(body)));
};
