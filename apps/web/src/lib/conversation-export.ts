/**
 * A conversation, exported: as JSON, everything via sent of it and the
 * prompts it kept of its failed turns, for a file; or as Markdown, a report to
 * paste into an issue or a chat, of its turns and of what went wrong in the
 * ones that failed or fell back.
 */
import { CapturedRequest as CapturedRequestSchema, Conversation } from "@via/server/admin-api";
import { Option, Schema } from "effect";
import type {
  CapturedRequest,
  Conversation as ConversationType,
  TurnAttempt,
} from "../api/types.ts";
import { categoryNames, attemptOutcomeNames } from "./attempt.ts";
import { type PromptMessage, type PromptPart, promptOf } from "./captured-prompt.ts";
import { harnessName } from "./harness.ts";
import { withoutPrefix } from "./model-entries.ts";
import { providerName } from "./provider-name.ts";
import { outcomeKind, outcomeOf } from "./request-outcome.ts";
import { byStart } from "./timeline.ts";
import {
  formatCount,
  formatDuration,
  formatMs,
  formatShare,
  formatTokens,
  formatUsd,
  tokensOf,
} from "./usage-format.ts";

const two = (value: number) => String(value).padStart(2, "0");

/**
 * The file a conversation exports to, named for it and for when, in the viewer's
 * time: `via-conversation-ses_1-20260927-0905.json`. The id keeps only what
 * every file system takes.
 */
export const exportFileName = (id: string, at: Date) => {
  const safe =
    id
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "conversation";

  const stamp = `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;

  return `via-conversation-${safe}-${stamp}.json`;
};

/** An export, as its file holds it: what via sent, as via writes it, and the prompts by request. */
const ExportFile = Schema.Struct({
  version: Schema.Literal(1),
  exportedAt: Schema.String,
  via: Schema.Struct({ version: Schema.String }),
  summary: Conversation.fields.summary,
  turns: Conversation.fields.turns,
  attempts: Conversation.fields.attempts,
  captured: Schema.Record(Schema.String, CapturedRequestSchema),
});

const encodeExport = Schema.encodeSync(ExportFile);

/** `conversation` and the prompts via kept of it, as its export file holds them. */
export const conversationJson = (
  conversation: ConversationType,
  captured: ReadonlyMap<string, CapturedRequest>,
  taken: { readonly exportedAt: Date; readonly version: string },
) =>
  encodeExport({
    version: 1,
    exportedAt: taken.exportedAt.toISOString(),
    via: { version: taken.version },
    summary: conversation.summary,
    turns: conversation.turns,
    attempts: conversation.attempts,
    captured: Object.fromEntries(captured),
  });

/** `text` with its line breaks, `\r\n` or `\r` as some clients write them, as `\n`. */
const unixLines = (text: string) => text.replace(/\r\n?/g, "\n");

/** `text` on one line, its line breaks spaces. */
const oneLine = (text: string) => unixLines(text).replace(/\s*\n\s*/g, " ");

/** The longest run of backticks in `text`. */
const longestTicks = (text: string) =>
  Math.max(0, ...Array.from(text.matchAll(/`+/g), ([run]) => run.length));

/**
 * Text as Markdown reads it as text, on one line: what a client or an upstream
 * wrote can't open a tag, a comment, a link or code, nor split a table's
 * row. Its own backslashes are escaped too, so none escapes an escape.
 */
export const inlineText = (text: string) => oneLine(text).replace(/[\\`<>[\]|]/g, "\\$&");

/** `text` in a code span, fenced with more backticks than any run in it. */
export const codeSpan = (text: string) => {
  const line = oneLine(text);
  const bar = "`".repeat(longestTicks(line) + 1);
  // A span that starts or ends with a backtick needs a space between it and its fence.
  const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";

  return `${bar}${pad}${line}${pad}${bar}`;
};

/** `text` in a fenced code block, fenced with more backticks than any run in it. */
export const fence = (text: string, language: string) => {
  const lines = unixLines(text);
  const bar = "`".repeat(Math.max(3, longestTicks(lines) + 1));

  return `${bar}${language}\n${lines}\n${bar}`;
};

/** How much of a message's text a report keeps; past it, it says how long it was. */
const MESSAGE_CHARS = 1_500;

/** How many of a failed turn's last messages a report shows. */
const LAST_MESSAGES = 5;

/** The roles that set a prompt up, rather than take part in it. */
const SETUP_ROLES = new Set(["system", "developer", "instructions"]);

const partText = (part: PromptPart) => {
  switch (part.kind) {
    case "text":
      return part.text;
    case "image":
      return part.label;
    case "reasoning":
      return `(reasoning) ${part.text}`;
    case "toolCall":
      return `→ ${part.name}(${part.arguments})`;
    case "toolResult":
      return `← ${Option.getOrElse(part.id, () => "result")}: ${part.text}`;
    case "other":
      return part.json;
  }
};

const messageMarkdown = (message: PromptMessage, hide: (text: string) => string) => {
  const text = hide(message.parts.map(partText).join("\n"));

  return text.length > MESSAGE_CHARS
    ? `**${inlineText(message.role)}**\n\n${fence(`${text.slice(0, MESSAGE_CHARS)}\n…`, "text")}\n\nTrimmed: ${formatCount(text.length)} characters in all.`
    : `**${inlineText(message.role)}**\n\n${fence(text, "text")}`;
};

const errorBodyText = (body: CapturedRequest["upstreamErrors"][number]["body"]) =>
  JSON.stringify(body, null, 2);

/** What a captured request holds for a report: its last messages, redactions and error bodies. */
const capturedMarkdown = (
  captured: CapturedRequest,
  hide: (text: string) => string,
): ReadonlyArray<string> => {
  const prompt = promptOf(captured.request);

  const lines = Option.match(prompt, {
    onNone: () => ["**Prompt** (in a shape via doesn't read; it's in the JSON export)"],
    onSome: ({ messages }) => {
      const taking = messages.filter((message) => !SETUP_ROLES.has(message.role));
      const setup = messages.length > taking.length;
      const last = taking.slice(-LAST_MESSAGES);

      const note = [
        `Last ${formatCount(last.length)} of ${formatCount(taking.length)} messages`,
        ...(setup ? ["the system prompt left out"] : []),
      ].join(", ");

      return [
        `**Prompt** to ${codeSpan(`/v1/${captured.endpoint}`)}: ${note}.`,
        ...last.map((message) => messageMarkdown(message, hide)),
      ];
    },
  });

  return [
    ...lines,
    ...(captured.redactions.length > 0
      ? [
          `Redacted: ${captured.redactions.map(({ kind, count }) => `${formatCount(count)} × ${inlineText(kind)}`).join(", ")}.`,
        ]
      : []),
    ...(captured.truncated
      ? ["via cut some long strings of this request short, to keep it under 4 MB."]
      : []),
    ...captured.upstreamErrors.flatMap(({ seq, status, body }) => [
      `**Upstream error**, attempt ${seq + 1}${status === null ? "" : `, HTTP ${status}`}`,
      fence(hide(errorBodyText(body)), "json"),
    ]),
  ];
};

/** One attempt, on one line: where it went, as whom, what for, and why it ended. */
const attemptLine = (attempt: TurnAttempt, hide: (text: string) => string) => {
  const route = Option.match(attempt.downstreamProvider, {
    onNone: () => providerName(attempt.provider),
    onSome: (downstream) => `${providerName(attempt.provider)} → ${downstream}`,
  });

  const said = [
    inlineText(route),
    ...Option.toArray(Option.map(attempt.accountLabel, (label) => inlineText(hide(label)))),
    inlineText(withoutPrefix(attempt.model) || "Unknown model"),
    ...Option.toArray(Option.map(attempt.status, (status) => `HTTP ${status}`)),
    Option.match(attempt.category, {
      onNone: () => attemptOutcomeNames[attempt.outcome],
      onSome: (category) => categoryNames[category],
    }),
    ...Option.toArray(Option.map(attempt.upstreamCode, codeSpan)),
  ].join(" · ");

  return `${attempt.seq + 1}. ${said}${Option.match(attempt.message, {
    onNone: () => "",
    onSome: (message) => `: ${inlineText(hide(message))}`,
  })}`;
};

const servedBy = (turn: ConversationType["turns"][number], hide: (text: string) => string) =>
  Option.match(turn.accountLabel, {
    onNone: () => providerName(turn.provider),
    onSome: (label) => `${providerName(turn.provider)} · ${hide(label)}`,
  });

const turnTokens = (turn: ConversationType["turns"][number]) =>
  Option.match(turn.inputTokens, {
    onNone: () => "–",
    onSome: (input) => formatTokens(input + Option.getOrElse(turn.outputTokens, () => 0)),
  });

/**
 * `conversation` as a Markdown report: its harness, id and totals, its turns as
 * a table, then each failed or fell-back turn's attempts and, when via kept it,
 * the last messages of its prompt and what the upstreams answered. Times are
 * written by `time`, and what privacy mode hides goes through `hide`.
 */
export const conversationMarkdown = (
  conversation: ConversationType,
  captured: ReadonlyMap<string, CapturedRequest>,
  writing: { readonly time: (at: number) => string; readonly hide: (text: string) => string },
) => {
  const { summary, attempts } = conversation;
  const { time, hide } = writing;
  // Numbered in the order they came, as the page numbers them.
  const turns = byStart(conversation.turns);

  const trouble = [
    ...(summary.subagents > 0
      ? [
          `${formatCount(summary.subagents)} ${summary.subagents === 1 ? "sub-agent" : "sub-agents"}`,
        ]
      : []),
    ...(summary.failed > 0 ? [`${formatCount(summary.failed)} failed`] : []),
    ...(summary.fellBack > 0 ? [`${formatCount(summary.fellBack)} fell back`] : []),
  ];

  const head = [
    `# ${inlineText(harnessName(summary.client, summary.source))} · ${inlineText(summary.id)}`,
    "",
    `- Started: ${time(summary.firstAt)}, lasted ${formatDuration(summary.lastAt - summary.firstAt)}`,
    `- Turns: ${formatCount(summary.turns)}${trouble.length > 0 ? ` (${trouble.join(", ")})` : ""}`,
    `- Tokens: ${formatTokens(tokensOf(summary))} (${formatTokens(summary.inputTokens)} in, ${formatTokens(summary.outputTokens)} out, ${formatShare(summary.cachedTokens, summary.inputTokens)} cached)`,
    `- API-equivalent cost: ${formatUsd(summary.cost.apiEquivalentUsd)}`,
    ...Option.toArray(Option.map(summary.keyName, (key) => `- Key: ${inlineText(hide(key))}`)),
    `- Models: ${summary.models.map((model) => inlineText(withoutPrefix(model))).join(", ")}`,
  ];

  const table = [
    "## Turns",
    "",
    "| # | Time | Model | Served by | Duration | TTFT | Tokens | Outcome |",
    "| ---: | --- | --- | --- | ---: | ---: | ---: | --- |",
    ...turns.map((turn, index) =>
      [
        String(index + 1),
        time(turn.at),
        withoutPrefix(turn.model) || "Unknown model",
        servedBy(turn, hide),
        formatMs(turn.durationMs),
        Option.match(turn.firstChunkMs, { onNone: () => "–", onSome: formatMs }),
        turnTokens(turn),
        outcomeOf(turn),
      ]
        // Its pipes escaped, a cell never adds a column.
        .map(inlineText)
        .reduce((row, cell) => `${row} ${cell} |`, "|"),
    ),
  ];

  const troubled = turns.flatMap((turn, index) => {
    const kind = outcomeKind(turn);

    if (kind !== "failed" && kind !== "fellBack") return [];

    const own = attempts.filter((attempt) => attempt.requestId === turn.requestId);
    const body = Option.fromNullishOr(captured.get(turn.requestId));

    const title = Option.match(turn.requestedModel, {
      onNone: () => `## Turn ${index + 1} · ${outcomeOf(turn)}`,
      onSome: (asked) =>
        `## Turn ${index + 1} · fell back from ${inlineText(withoutPrefix(asked))}`,
    });

    const blocks = [
      title,
      ...Option.toArray(
        Option.map(turn.errorMessage, (message) => `> ${inlineText(hide(message))}`),
      ),
      ...(own.length > 0
        ? [["**Attempts**", "", ...own.map((attempt) => attemptLine(attempt, hide))].join("\n")]
        : []),
      ...Option.match(body, {
        onNone: () => [],
        onSome: (kept) => capturedMarkdown(kept, hide),
      }),
    ];

    return [blocks.join("\n\n")];
  });

  return `${[head.join("\n"), table.join("\n"), ...troubled].join("\n\n")}\n`;
};
