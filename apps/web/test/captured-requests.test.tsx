import { act, screen, waitFor, within } from "@testing-library/react";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturedRequest, Conversation } from "../src/api/types.ts";
import { attempt, conversation, request } from "../src/testing/history.ts";
import { renderApp } from "./app.tsx";
import { openSource } from "./event-source.ts";

const now = new Date("2026-09-27T12:30:00.000Z");

const T0 = Date.parse("2026-09-27T11:30:00.000Z");

const failed = request({
  requestId: "t2",
  at: T0 + 20_000,
  status: 502,
  error: Option.some("upstream_unavailable"),
  errorMessage: Option.some("Every upstream failed"),
  conversationId: Option.some("ses_1"),
  inputTokens: Option.none(),
  outputTokens: Option.none(),
});

const opened: Conversation = {
  summary: conversation({ id: "ses_1", turns: 3, failed: 2, firstAt: T0, lastAt: T0 + 40_000 }),
  turns: [
    request({ requestId: "t1", at: T0, conversationId: Option.some("ses_1") }),
    failed,
    request({
      requestId: "t3",
      at: T0 + 40_000,
      status: 400,
      error: Option.some("invalid_request"),
      conversationId: Option.some("ses_1"),
    }),
  ],
  attempts: [
    attempt({ requestId: "t1", startedAt: T0 }),
    attempt({
      requestId: "t2",
      startedAt: T0 + 20_000,
      provider: "openrouter",
      status: Option.some(502),
      outcome: "failed",
      category: Option.some("downstream_unavailable"),
      downstreamProvider: Option.some("Together"),
    }),
    attempt({
      requestId: "t3",
      startedAt: T0 + 40_000,
      status: Option.some(400),
      outcome: "refused",
      category: Option.some("bad_request"),
    }),
  ],
  captured: [],
};

const kept: CapturedRequest = {
  requestId: "t2",
  capturedAt: T0 + 21_000,
  endpoint: "chat/completions",
  request: {
    model: "gpt-6-astra",
    max_tokens: 2_048,
    tools: [{ type: "function", function: { name: "read_file" } }],
    messages: [
      { role: "system", content: "You are a careful coding agent." },
      { role: "user", content: "My key is [redacted:openai-key], look at [image: png, 412 KB]" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "export const a = 1;" },
    ],
  },
  upstreamErrors: [
    { seq: 0, status: 502, body: { error: { message: "Together is down for maintenance" } } },
  ],
  redactions: [{ kind: "openai-key", count: 1 }],
  truncated: true,
  sizeBytes: 12_400,
};

const seed = { conversations: [opened], captured: new Map([["t2", kept]]) };

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const turnsTable = () => screen.findByRole("table", { name: "Turns" });

const rowOf = async (index: number) => {
  const rows = within(await turnsTable())
    .getAllByRole("row")
    .slice(1);

  return rows[index] ?? document.body;
};

describe("a failed turn's captured request", () => {
  it("is offered only on a turn whose prompt via kept", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    expect(within(await rowOf(1)).getByRole("button", { name: "View request" })).toBeDefined();
    expect(within(await rowOf(0)).queryByRole("button", { name: "View request" })).toBeNull();
    expect(within(await rowOf(2)).queryByRole("button", { name: "View request" })).toBeNull();
  });

  it("opens in a sheet as a conversation, fetched only once opened", async () => {
    const { state, user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    const view = within(await rowOf(1)).getByRole("button", { name: "View request" });

    expect(state.requests).not.toContain("GET /admin/history/requests/t2/body");
    await user.click(view);

    const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });
    await within(sheet).findByText("read_file", { selector: "code" });

    expect(state.requests).toContain("GET /admin/history/requests/t2/body");
    // Its parameters, tools and messages by role.
    expect(sheet.textContent).toContain("2048");
    expect(within(sheet).getByRole("listitem", { name: "Tool read_file" })).toBeDefined();
    expect(sheet.textContent).toContain("My key is");
    expect(sheet.textContent).toContain('"path": "src/a.ts"');
    expect(sheet.textContent).toContain("export const a = 1;");
    // The system prompt is folded away until asked for.
    const system = within(sheet).getByRole("button", { name: /System prompt/ });
    expect(system.getAttribute("aria-expanded")).toBe("false");
    expect(system.getAttribute("aria-controls")).toBeNull();
    await user.click(system);
    const shown = document.getElementById(system.getAttribute("aria-controls") ?? "");
    expect(shown?.textContent).toContain("You are a careful coding agent.");
  });

  it("marks what via redacted and the images it left out, and says what it cut", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    await user.click(within(await rowOf(1)).getByRole("button", { name: "View request" }));
    const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });

    const secret = await within(sheet).findByText("[redacted:openai-key]");
    expect(secret.getAttribute("title")).toContain("removed");
    expect(within(sheet).getByText("[image: png, 412 KB]")).toBeDefined();
    expect(sheet.textContent).toContain("1 × openai-key");
    expect(sheet.textContent).toMatch(/cut some long strings short/);
  });

  it("ends with what each upstream answered", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    await user.click(within(await rowOf(1)).getByRole("button", { name: "View request" }));
    const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });

    const answer = await within(sheet).findByRole("region", { name: /Attempt 1/ });
    expect(answer.textContent).toContain("OpenRouter → Together");
    expect(answer.textContent).toContain("HTTP 502");
    expect(answer.textContent).toContain("Downstream unavailable");
    expect(answer.textContent).toContain("Together is down for maintenance");
  });

  it("copies the whole of it as JSON", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    await user.click(within(await rowOf(1)).getByRole("button", { name: "View request" }));
    const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });

    await user.click(await within(sheet).findByRole("button", { name: "Copy JSON" }));

    expect(await screen.findByText("Request copied")).toBeDefined();
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('"requestId": "t2"');
    expect(copied).toContain("Together is down for maintenance");
  });

  it("opens from the failed turn's card on the timeline too", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    const timeline = await screen.findByRole("list", { name: "Timeline" });
    const card = within(timeline).getByRole("article", { name: /^Turn 2,/ });

    await user.click(within(card).getByRole("button", { name: "View request" }));

    expect(await screen.findByRole("dialog", { name: "Request of turn 2" })).toBeDefined();
  });

  it("shows a body of a shape it doesn't read as JSON", async () => {
    const odd: CapturedRequest = { ...kept, request: { prompt: "complete this" } };

    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", {
      ...seed,
      captured: new Map([["t2", odd]]),
    });

    await user.click(within(await rowOf(1)).getByRole("button", { name: "View request" }));
    const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });

    await waitFor(() => expect(sheet.textContent).toContain('"prompt": "complete this"'));
  });

  it("isn't fetched again when via says the history changed, as it never changes", async () => {
    const { state, user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    await user.click(within(await rowOf(1)).getByRole("button", { name: "View request" }));
    const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });
    await within(sheet).findByRole("region", { name: /Attempt 1/ });

    const bodies = () =>
      state.requests.filter((asked) => asked === "GET /admin/history/requests/t2/body").length;

    const conversations = () =>
      state.requests.filter((asked) => asked === "GET /admin/history/conversations/ses_1").length;

    const before = conversations();
    act(() => openSource().history());

    await waitFor(() => expect(conversations()).toBeGreaterThan(before));
    expect(bodies()).toBe(1);
  });

  it("says so when via no longer has the prompt", async () => {
    const { state, user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    const view = within(await rowOf(1)).getByRole("button", { name: "View request" });
    state.captured = new Map();

    await user.click(view);
    const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });

    expect(await within(sheet).findByRole("heading", { name: "No prompt kept" })).toBeDefined();
  });
});

const email = "dev@corp.example";

const leaky: CapturedRequest = {
  ...kept,
  request: {
    model: "gpt-6-astra",
    user: email,
    messages: [
      { role: "system", content: `Write to ${email} when stuck.` },
      { role: "user", content: `Mail ${email} the report` },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", function: { name: "send", arguments: `{"to":"${email}"}` } }],
      },
      { role: "tool", tool_call_id: "call_1", content: `Sent to ${email}` },
    ],
  },
  upstreamErrors: [{ seq: 0, status: 502, body: { error: { message: `No ${email}` } } }],
};

const openedPrivately = async (captured: CapturedRequest) => {
  localStorage.setItem("via.privacy", "on");

  const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", {
    ...seed,
    captured: new Map([["t2", captured]]),
  });

  await user.click(within(await rowOf(1)).getByRole("button", { name: "View request" }));
  const sheet = await screen.findByRole("dialog", { name: "Request of turn 2" });
  await within(sheet).findByRole("region", { name: /Attempt 1/ });

  return sheet;
};

describe("a captured request, in privacy mode", () => {
  afterEach(() => localStorage.clear());

  it("hides the emails in its messages, tool calls and results, and a folded prompt's preview", async () => {
    const sheet = await openedPrivately(leaky);

    expect(sheet.textContent).toContain("Mail •••••@•••••.example the report");
    expect(sheet.textContent).toContain("Sent to •••••@•••••.example");
    expect(sheet.textContent).toContain("Write to •••••@•••••.example when stuck.");
    expect(sheet.textContent).not.toContain(email);
  });

  it("hides them in a body it shows as JSON", async () => {
    const sheet = await openedPrivately({
      ...leaky,
      request: { prompt: `complete this for ${email}` },
    });

    await waitFor(() => expect(sheet.textContent).toContain("for •••••@•••••.example"));
    expect(sheet.textContent).not.toContain(email);
  });
});

describe("the Conversations tab, while via keeps failed prompts", () => {
  it("says so, calmly, with a link to the setting", async () => {
    const { router, user } = renderApp("/usage?tab=conversations", {
      ...seed,
      capture: { keepFailedPrompts: true },
    });

    const link = await screen.findByRole("link", { name: /Capturing failed prompts/ });
    await user.click(link);

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(router.state.location.hash).toBe("keep-failed-prompts");
  });

  it("says nothing while it's off", async () => {
    renderApp("/usage?tab=conversations", seed);
    await screen.findByRole("table", { name: "Conversations" });

    expect(screen.queryByRole("link", { name: /Capturing failed prompts/ })).toBeNull();
  });

  it("says nothing on the Requests tab", async () => {
    renderApp("/usage", { ...seed, capture: { keepFailedPrompts: true } });
    await screen.findByRole("tab", { name: "Requests" });

    expect(screen.queryByRole("link", { name: /Capturing failed prompts/ })).toBeNull();
  });
});

describe("exporting a conversation", () => {
  it("copies it as a Markdown report, its captured prompt included", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    await user.click(await screen.findByRole("button", { name: "Export" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copy as Markdown" }));

    expect(await screen.findByText("Markdown copied")).toBeDefined();
    const copied = await navigator.clipboard.readText();
    expect(copied).toMatch(/^# OpenCode 1\.19\.3 · ses_1/);
    expect(copied).toContain("| # | Time | Model |");
    expect(copied).toContain("My key is [redacted:openai-key]");
    expect(copied).toContain("Together is down for maintenance");
  });

  it("downloads it as JSON, named for the conversation, its captured prompts by request", async () => {
    const made: Array<Blob> = [];
    const names: Array<string> = [];

    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      if (blob instanceof Blob) made.push(blob);

      return "blob:via-export";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });

    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    await user.click(await screen.findByRole("button", { name: "Export" }));
    await user.click(await screen.findByRole("menuitem", { name: "Download JSON" }));

    await waitFor(() => expect(names).toHaveLength(1));
    expect(names[0]).toMatch(/^via-conversation-ses_1-\d{8}-\d{4}\.json$/);
    const file = await made[0]?.text();
    expect(file).toContain('"version": 1');
    expect(file).toContain('"t2": {');
    expect(file).toContain("Together is down for maintenance");
  });

  it("warns, in the menu, when the export holds captured prompts", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    await user.click(await screen.findByRole("button", { name: "Export" }));
    const menu = await screen.findByRole("menu");

    expect(menu.textContent).toContain("1 captured prompt");
  });

  it("warns of nothing when it holds none", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", {
      conversations: [opened],
    });

    await user.click(await screen.findByRole("button", { name: "Export" }));
    const menu = await screen.findByRole("menu");

    expect(menu.textContent).not.toContain("captured prompt");
  });
});
