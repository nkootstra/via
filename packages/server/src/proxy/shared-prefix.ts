import { Schema } from "effect";

// OpenCode writes the session's own id into the `<env>` block near the top of
// its system prompt. Its sub-agents otherwise send the same system prompt and
// tools as each other and as their parent, so that one line, a few hundred
// tokens in, is all that stops them sharing a prompt cache.
const SESSION_LINE = /^[ \t]*(Current conversation session ID: [^\n]*)\n?/m;

const isMessages = Schema.is(Schema.Array(Schema.JsonObject));

/** A system or developer message whose prompt carries OpenCode's session line. */
const isSessionInstruction = Schema.is(
  Schema.Struct({
    role: Schema.Literals(["system", "developer"]),
    content: Schema.String.check(Schema.isPattern(SESSION_LINE)),
  }),
);

const isUser = Schema.is(Schema.Struct({ role: Schema.Literal("user"), content: Schema.Json }));

const isText = Schema.is(Schema.String);

const isParts = Schema.is(Schema.Array(Schema.Json));

const prepend = (content: Schema.Json | undefined, line: string) =>
  isParts(content)
    ? [{ type: "text", text: line }, ...content]
    : isText(content)
      ? `${line}\n\n${content}`
      : undefined;

/**
 * `body`, a chat completion, with OpenCode's session line moved from its
 * system prompt to the start of its first user message, so that requests from
 * different sessions of one project share everything before their first user
 * message. The model still reads the line; only its place changes. A request
 * without the line, or without a user message to take it, is left as it is.
 */
export const withSharedPrefix = (body: Schema.JsonObject) => {
  const messages = isMessages(body["messages"]) ? body["messages"] : [];
  const instruction = messages.find(isSessionInstruction);
  const user = messages.find(isUser);

  if (instruction === undefined || user === undefined) return body;
  const system = instruction.content;
  const line = SESSION_LINE.exec(system)?.[1];
  const content = line === undefined ? undefined : prepend(user.content, line);

  if (content === undefined) return body;

  return {
    ...body,
    messages: messages.map((message) =>
      message === instruction
        ? { ...instruction, content: system.replace(SESSION_LINE, "") }
        : message === user
          ? { ...user, content }
          : message,
    ),
  };
};
