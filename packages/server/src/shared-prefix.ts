type Body = Readonly<Record<string, unknown>>;

// opencode writes the session's own id into the `<env>` block near the top of
// its system prompt. Its sub-agents otherwise send the same system prompt and
// tools as each other and as their parent, so that one line, a few hundred
// tokens in, is all that stops them sharing a prompt cache.
const SESSION_LINE = /^[ \t]*(Current conversation session ID: [^\n]*)\n?/m;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isInstruction = (message: unknown) =>
  isRecord(message) && (message["role"] === "system" || message["role"] === "developer");

const prepend = (content: unknown, line: string) =>
  Array.isArray(content)
    ? [{ type: "text", text: line }, ...content]
    : typeof content === "string"
      ? `${line}\n\n${content}`
      : undefined;

/**
 * `body`, a chat completion, with opencode's session line moved from its
 * system prompt to the start of its first user message, so that requests from
 * different sessions of one project share everything before their first user
 * message. The model still reads the line; only its place changes. A request
 * without the line, or without a user message to take it, is left as it is.
 */
export const withSharedPrefix = (body: Body): Body => {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const at = messages.findIndex(
    (message) =>
      isInstruction(message) &&
      typeof message["content"] === "string" &&
      SESSION_LINE.test(message["content"]),
  );
  const userAt = messages.findIndex((message) => isRecord(message) && message["role"] === "user");
  const instruction = messages[at];
  const user = messages[userAt];
  const system = isRecord(instruction) ? instruction["content"] : undefined;
  if (!isRecord(instruction) || !isRecord(user) || typeof system !== "string") return body;
  const line = SESSION_LINE.exec(system)?.[1];
  const content = line === undefined ? undefined : prepend(user["content"], line);
  if (content === undefined) return body;
  return {
    ...body,
    messages: messages.map((message, index) =>
      index === at
        ? { ...instruction, content: system.replace(SESSION_LINE, "") }
        : index === userAt
          ? { ...user, content }
          : message,
    ),
  };
};
