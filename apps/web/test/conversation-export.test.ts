import { Arbitrary, Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CapturedRequest, Conversation } from "../src/api/types.ts";
import {
  codeSpan,
  conversationJson,
  conversationMarkdown,
  exportFileName,
  fence,
  inlineText,
} from "../src/lib/conversation-export.ts";
import { attempt, conversation, request } from "../src/testing/history.ts";

const T0 = Date.parse("2026-09-27T11:30:00.000Z");

const failedTurn = request({
  requestId: "t2",
  at: T0 + 20_000,
  status: 502,
  error: Option.some("upstream_unavailable"),
  errorMessage: Option.some("Every upstream failed"),
  inputTokens: Option.none(),
  outputTokens: Option.none(),
  durationMs: 1_500,
  firstChunkMs: Option.none(),
});

const opened: Conversation = {
  summary: conversation({
    id: "ses_1",
    turns: 2,
    failed: 1,
    firstAt: T0,
    lastAt: T0 + 21_500,
  }),
  turns: [request({ requestId: "t1", at: T0, model: "gpt|6" }), failedTurn],
  attempts: [
    attempt({ requestId: "t1", startedAt: T0 }),
    attempt({
      requestId: "t2",
      startedAt: T0 + 20_000,
      durationMs: 1_500,
      provider: "openrouter",
      model: "openrouter/qwen-4-coder",
      accountLabel: Option.some("work@example.com"),
      status: Option.some(502),
      outcome: "failed",
      category: Option.some("downstream_unavailable"),
      upstreamCode: Option.some("provider_error"),
      downstreamProvider: Option.some("Together"),
      message: Option.some("Provider returned error"),
    }),
  ],
  captured: ["t2"],
};

const captured: CapturedRequest = {
  requestId: "t2",
  capturedAt: T0 + 21_500,
  endpoint: "chat/completions",
  request: {
    model: "openrouter/qwen-4-coder",
    messages: [
      { role: "system", content: "You are a coding agent." },
      ...Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `message ${i + 1}` })),
      { role: "user", content: "x".repeat(3_000) },
    ],
  },
  upstreamErrors: [
    { seq: 0, status: 502, body: { error: { message: "Provider returned error" } } },
  ],
  redactions: [{ kind: "openai-key", count: 2 }],
  truncated: false,
  sizeBytes: 4_096,
};

const time = (at: number) => new Date(at).toISOString().slice(11, 19);

const shown = (text: string) => text;

describe("a conversation's export", () => {
  it("is named for the conversation and when it was taken, safe for any file system", () => {
    expect(exportFileName("ses_1", new Date(2026, 8, 27, 9, 5))).toBe(
      "via-conversation-ses_1-20260927-0905.json",
    );
    expect(exportFileName("ses:agent/1 ..", new Date(2026, 0, 2, 13, 45))).toBe(
      "via-conversation-ses-agent-1-20260102-1345.json",
    );
  });

  it("holds the conversation as via sends it, its captured prompts by request", () => {
    const json = conversationJson(opened, new Map([["t2", captured]]), {
      exportedAt: new Date(T0 + 60_000),
      version: "1.2.3",
    });

    expect(json).toMatchObject({
      version: 1,
      exportedAt: "2026-09-27T11:31:00.000Z",
      via: { version: "1.2.3" },
      summary: { id: "ses_1", client: "opencode/1.19.3" },
      captured: { t2: { endpoint: "chat/completions", truncated: false } },
    });
    expect(json["turns"]).toHaveLength(2);
    // Options are written as via writes them: null when none.
    expect(json["turns"]).toMatchObject([{ requestId: "t1" }, { inputTokens: null }]);
    expect(json["attempts"]).toHaveLength(2);
  });
});

describe("a conversation as Markdown", () => {
  const markdown = conversationMarkdown(opened, new Map([["t2", captured]]), { time, hide: shown });

  it("opens with its harness, id and totals", () => {
    expect(markdown).toMatch(/^# OpenCode 1\.19\.3 · ses_1\n/);
    expect(markdown).toContain("- Turns: 2 (1 failed)");
    expect(markdown).toContain("- API-equivalent cost: $0.12");
  });

  it("tables its turns, a pipe in a cell escaped", () => {
    expect(markdown).toContain(
      "| # | Time | Model | Served by | Duration | TTFT | Tokens | Outcome |",
    );
    expect(markdown).toContain(
      "| 1 | 11:30:00 | gpt\\|6 | Codex · work@example.com | 2.4 s | 600 ms | 1.5K | OK |",
    );
    expect(markdown).toContain(
      "| 2 | 11:30:20 | gpt-6-astra | Codex · work@example.com | 1.5 s | – | – | Unreachable |",
    );
  });

  it("details each failed turn's attempts, and its prompt's last five messages when captured", () => {
    const failed = markdown.slice(markdown.indexOf("## Turn 2"));

    expect(failed).toContain(
      "1. OpenRouter → Together · work@example.com · qwen-4-coder · HTTP 502 · Downstream unavailable · `provider_error`: Provider returned error",
    );
    expect(failed).toContain("Last 5 of 7 messages, the system prompt left out");
    expect(failed).not.toContain("message 2");
    expect(failed).toContain("message 3");
    expect(failed).toContain("Trimmed: 3,000 characters in all.");
    expect(failed).toContain("Redacted: 2 × openai-key.");
    expect(failed).toContain('"message": "Provider returned error"');
  });

  it("leaves out the turns that went fine", () => {
    expect(markdown).not.toContain("## Turn 1");
  });

  it("numbers the turns in the order they came, as the page does", () => {
    const later = conversationMarkdown(
      { ...opened, turns: [failedTurn, request({ requestId: "t1", at: T0 })] },
      new Map(),
      { time, hide: shown },
    );

    expect(later).toContain("| 1 | 11:30:00 |");
    expect(later).toContain("| 2 | 11:30:20 |");
    expect(later).toContain("## Turn 2 · Unreachable");
  });

  it("hides what privacy mode hides", () => {
    const hidden = conversationMarkdown(opened, new Map(), {
      time,
      hide: (text) => text.replace("work@example.com", "•••"),
    });

    expect(hidden).not.toContain("work@example.com");
  });
});

describe("Markdown's pieces", () => {
  it("fences text in more backticks than it holds", () => {
    expect(fence("plain", "json")).toBe("```json\nplain\n```");
    expect(fence("a ``` b", "")).toBe("````\na ``` b\n````");
    expect(fence("a ````` b", "text")).toBe("``````text\na ````` b\n``````");
  });

  it("keeps a table cell on one line, its pipes and backticks escaped", () => {
    expect(inlineText("a | b `c`\nd")).toBe("a \\| b \\`c\\` d");
  });
});

describe("Markdown's escaping", () => {
  it("keeps a backslash before a pipe in its cell", () => {
    expect(inlineText("team\\|backup")).toBe("team\\\\\\|backup");
  });

  it("keeps a cell on one line whatever its line breaks", () => {
    expect(inlineText("a\r\nb\rc")).toBe("a b c");
  });

  it("writes inline text as text, never as a link, tag or comment", () => {
    expect(inlineText("<!-- [x](y) --> <b>")).toBe("\\<!-- \\[x\\](y) --\\> \\<b\\>");
  });

  it("puts a code in a span fenced with more backticks than it holds", () => {
    expect(codeSpan("rate_limit")).toBe("`rate_limit`");
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("`x")).toBe("`` `x ``");
  });

  it("escapes what the client and the upstreams wrote", () => {
    const sly = "<!-- hidden --> [click](http://x)";

    const markdown = conversationMarkdown(
      {
        ...opened,
        summary: { ...opened.summary, id: "ses_<!--1-->" },
        turns: [opened.turns[0] ?? failedTurn, { ...failedTurn, errorMessage: Option.some(sly) }],
        attempts: opened.attempts.map((tried) => ({
          ...tried,
          message: Option.some(sly),
          upstreamCode: Option.some("a`b"),
        })),
      },
      new Map([
        [
          "t2",
          {
            ...captured,
            request: { messages: [{ role: "<!--user-->", content: "hi" }] },
          },
        ],
      ]),
      { time, hide: shown },
    );

    expect(markdown).not.toMatch(/(^|[^\\])<!--/m);
    expect(markdown).not.toMatch(/(^|[^\\])\[click/m);
    expect(markdown).toContain("``a`b``");
  });
});

/** Checks `property` over generated values, failing with the shrunk counterexample. */
const holds = <A>(values: Arbitrary.Arbitrary<A>, property: (value: A) => boolean) => {
  const result = Effect.runSync(Arbitrary.checkEffect(values, property));

  expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
};

/** Text of what Markdown reads as more than text. */
const tricky = Arbitrary.schema(
  Schema.Array(
    Schema.Literals(["a", " ", "|", "\\", "`", "<", ">", "!", "-", "[", "]", "(", ")", "\r", "\n"]),
  ),
);

/** Of `text`, the characters Markdown reads as they are: those no backslash escapes. */
const unescaped = (text: string) => {
  const raw: Array<string> = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else raw.push(text[index] ?? "");
  }

  return raw;
};

describe("Markdown's escaping, for any text", () => {
  it("makes a cell that never adds a column, nor a line", () => {
    holds(tricky, (chars) => {
      const cell = inlineText(chars.join(""));

      // GitHub splits a row on each pipe no backslash escapes.
      return !unescaped(cell).includes("|") && !/[\r\n]/.test(cell);
    });
  });

  it("leaves no tag nor comment open in inline text, nor a link", () => {
    holds(tricky, (chars) => {
      const raw = unescaped(inlineText(chars.join("")));

      return !raw.includes("<") && !raw.includes("[") && !/[\r\n]/.test(raw.join(""));
    });
  });
});
