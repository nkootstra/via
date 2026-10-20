import { createHash } from "node:crypto";
import { Option, Schema } from "effect";

type Headers = Readonly<Record<string, string | undefined>>;

// Where coding agents put their conversation id: OpenCode sends
// `x-opencode-session-id` (older builds, Kilo and Hermes `x-opencode-session`);
// Claude Code `x-claude-code-session-id`; Codex `session-id`, which its
// sub-agents share, plus `thread-id` and `prompt_cache_key`; Cline and Roo
// `session_id` on their Codex paths and `x-task-id`; OpenCode `x-session-id`
// to other providers.
// OpenCode's sub-agents also send `x-parent-session-id`, which comes first:
// sibling sub-agents repeat one system prompt and tool list, and upstreams
// (OpenCode Go among them) route by session, so sharing the parent's keeps
// them on one warm prompt cache instead of each prefilling it cold.
const sources: ReadonlyArray<
  (headers: Headers, body: Schema.JsonObject) => Schema.Json | undefined
> = [
  (headers) => headers["x-parent-session-id"],
  (headers) => headers["x-opencode-session-id"],
  (headers) => headers["x-opencode-session"],
  (headers) => headers["x-claude-code-session-id"],
  (headers) => headers["session-id"],
  (headers) => headers["session_id"],
  (headers) => headers["thread-id"],
  (headers) => headers["x-session-id"],
  (_, body) => body["session_id"],
  (_, body) => body["prompt_cache_key"],
  (headers) => headers["x-task-id"],
  (headers) => headers["x-kilocode-taskid"],
];

// OpenRouter caps session ids at 256 characters.
const MAX_LENGTH = 256;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const isId = Schema.is(Schema.NonEmptyString);

const isInstruction = Schema.is(Schema.Struct({ role: Schema.Literals(["system", "developer"]) }));

const isUser = Schema.is(Schema.Struct({ role: Schema.Literal("user") }));

const isMessages = Schema.is(Schema.Array(Schema.Json));

// A Responses input: a single string or a list of items.
const isInput = Schema.is(Schema.Union([Schema.String, Schema.Array(Schema.Json)]));

/**
 * The start of a conversation, which every later turn repeats: the first
 * system or developer message and the first user message, or for the
 * Responses API the instructions and the first input item.
 */
const opening = (body: Schema.JsonObject) => {
  const messages = body["messages"];
  const input = body["input"];

  if (isInput(input) || body["instructions"] !== undefined) {
    return [body["instructions"], isMessages(input) ? input[0] : input];
  }

  const list = isMessages(messages) ? messages : [];

  return [list.find(isInstruction), list.find(isUser)];
};

/**
 * One id for the conversation a request belongs to, so providers can keep it
 * on a warm prompt cache: the id the client sent, else one derived from the
 * conversation's opening, as OpenRouter does itself.
 */
export const resolveSession = (headers: Headers, body: Schema.JsonObject): string => {
  for (const source of sources) {
    const id = source(headers, body);

    if (isId(id)) return id.length > MAX_LENGTH ? sha256(id) : id;
  }

  return guess(body);
};

/** An id for a conversation whose client sent none, from its opening, which every turn repeats. */
const guess = (body: Schema.JsonObject) => sha256(JSON.stringify(opening(body)));

/**
 * Where a client sends an id: a header, by its name, or a field of the body,
 * as `body.<path>`.
 */
type Source = readonly [
  name: string,
  read: (headers: Headers, body: Schema.JsonObject) => Schema.Json | undefined,
];

const header = (name: string): Source => [name, (headers) => headers[name]];

const isObject = Schema.is(Schema.JsonObject);

const field = (...path: ReadonlyArray<string>): Source => [
  `body.${path.join(".")}`,
  (_, body) =>
    path.reduce<Schema.Json | undefined>(
      (value, key) => (isObject(value) ? value[key] : undefined),
      body,
    ),
];

// A request's own conversation, most specific first: Codex's thread (its
// `session-id` is shared by a thread and its sub-agents), OpenCode's own
// session, then the ids the routing key reads.
const ownSources: ReadonlyArray<Source> = [
  header("thread-id"),
  field("client_metadata", "thread_id"),
  header("x-opencode-session-id"),
  header("x-opencode-session"),
  // What older Codex builds call a thread.
  header("conversation_id"),
  header("session-id"),
  header("session_id"),
  header("x-session-id"),
  header("x-session-affinity"),
  field("client_metadata", "session_id"),
  field("session_id"),
  field("prompt_cache_key"),
  header("x-task-id"),
  header("x-kilocode-taskid"),
];

// The conversation that started a sub-agent's: Codex's parent thread, OpenCode's parent session.
const parentSources: ReadonlyArray<Source> = [
  header("x-codex-parent-thread-id"),
  header("x-opencode-parent-session-id"),
  header("x-parent-session-id"),
];

// What kind of sub-agent a request comes from, such as Codex's `review` or Claude Code's `Explore`.
const agentTypeSources: ReadonlyArray<Source> = [
  header("x-openai-subagent"),
  header("x-claude-code-agent-type"),
];

/** The first id one of `sources` holds, with the source's name. */
const firstOf = (candidates: ReadonlyArray<Source>, headers: Headers, body: Schema.JsonObject) =>
  Option.firstSomeOf(
    candidates.map(([name, read]) => {
      const id = read(headers, body);

      return isId(id) ? Option.some({ id, source: name }) : Option.none();
    }),
  );

/**
 * The longest conversation id kept as it came: the router refuses a longer path
 * parameter, so a longer one is kept as its hash, which looks it up just as well.
 */
const MAX_CONVERSATION_LENGTH = 100;

const conversationKey = (id: string) => (id.length > MAX_CONVERSATION_LENGTH ? sha256(id) : id);

/** The longest sub-agent type kept; no client sends a longer one. */
const MAX_AGENT_TYPE_LENGTH = 64;

/** Which conversation a request belongs to, as the usage history groups requests. */
export interface Conversation {
  /** The request's own conversation: a sub-agent's is its own, not its parent's. */
  readonly conversationId: string;
  /** The conversation that started this one, for a sub-agent's; never the conversation itself. */
  readonly parentConversationId: Option.Option<string>;
  /** Where the id came from: a header's name, `body.<field>`, or `hash` for one guessed. */
  readonly source: string;
  /** What kind of sub-agent sent the request, when its client says. */
  readonly agentType: Option.Option<string>;
}

interface Found {
  readonly id: string;
  readonly source: string;
  readonly parent?: string;
}

/**
 * Claude Code's conversation: its session, or, for a sub-agent, the agent within
 * its session, under the agent that started it, else under the session.
 */
const claudeCode = (headers: Headers): Option.Option<Found> => {
  const session = headers["x-claude-code-session-id"];

  if (!isId(session)) return Option.none();

  const agent = headers["x-claude-code-agent-id"];

  if (!isId(agent)) return Option.some({ id: session, source: "x-claude-code-session-id" });

  const parent = headers["x-claude-code-parent-agent-id"];

  return Option.some({
    id: `${session}:${agent}`,
    source: "x-claude-code-agent-id",
    parent: isId(parent) ? `${session}:${parent}` : session,
  });
};

/**
 * The conversation a request belongs to, as the usage history shows it. Unlike
 * `resolveSession`, which gives a sub-agent its parent's session so they share a
 * warm prompt cache, it names the request's own conversation, and its parent apart.
 */
export const resolveConversation = (headers: Headers, body: Schema.JsonObject): Conversation => {
  const own = Option.orElse(claudeCode(headers), (): Option.Option<Found> =>
    firstOf(ownSources, headers, body),
  );

  const conversationId = conversationKey(
    Option.match(own, { onNone: () => guess(body), onSome: (found) => found.id }),
  );

  const parentConversationId = Option.flatMapNullishOr(own, (found) => found.parent).pipe(
    Option.orElse(() => Option.map(firstOf(parentSources, headers, body), (found) => found.id)),
    Option.map(conversationKey),
    Option.filter((id) => id !== conversationId),
  );

  return {
    conversationId,
    parentConversationId,
    source: Option.match(own, { onNone: () => "hash", onSome: (found) => found.source }),
    agentType: firstOf(agentTypeSources, headers, body).pipe(
      Option.map((found) => found.id),
      Option.filter((type) => type.length <= MAX_AGENT_TYPE_LENGTH),
    ),
  };
};
