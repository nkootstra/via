import { act, screen, waitFor, within } from "@testing-library/react";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, TurnAttempt } from "../src/api/types.ts";
import {
  attempt as keptAttempt,
  breakdown,
  conversation,
  cost,
  group,
  request,
} from "../src/testing/history.ts";
import { renderApp } from "./app.tsx";
import { openSource } from "./event-source.ts";

const now = new Date("2026-09-27T12:30:00.000Z");

const T0 = Date.parse("2026-09-27T11:30:00.000Z");

const turn = (requestId: string, at: number, fields: Partial<Parameters<typeof request>[0]> = {}) =>
  request({
    requestId,
    at: T0 + at,
    durationMs: 2_000,
    firstChunkMs: Option.some(500),
    conversationId: Option.some("ses_1"),
    sessionSource: Option.some("x-opencode-session-id"),
    client: Option.some("opencode/1.19.3"),
    ...fields,
  });

/** An upstream attempt of `requestId` that served, from `at` (after T0) for `durationMs`. */
const attempt = (
  requestId: string,
  seq: number,
  at: number,
  durationMs: number,
  fields: Partial<TurnAttempt> = {},
) => keptAttempt({ requestId, seq, startedAt: T0 + at, durationMs, ...fields });

/** OpenCode's conversation: two turns of its own, a reviewer's two, and one that fell back. */
const opencode: Conversation = {
  summary: conversation({
    id: "ses_1",
    models: ["gpt-6-astra", "opencode-go/kimi-k3"],
    turns: 5,
    subagents: 1,
    failed: 1,
    fellBack: 1,
    firstAt: T0,
    lastAt: T0 + 60_000,
  }),
  turns: [
    turn("t1", 0),
    turn("s1", 10_000, {
      conversationId: Option.some("ses_1:review"),
      parentConversationId: Option.some("ses_1"),
      agentType: Option.some("review"),
    }),
    turn("s2", 20_000, {
      conversationId: Option.some("ses_1:review"),
      parentConversationId: Option.some("ses_1"),
      agentType: Option.some("review"),
      status: 502,
      error: Option.some("upstream_unavailable"),
      errorMessage: Option.some("Codex is unreachable"),
      inputTokens: Option.none(),
      outputTokens: Option.none(),
    }),
    turn("t2", 40_000, {
      model: "opencode-go/kimi-k3",
      provider: "opencode-go",
      accountLabel: Option.some("go main"),
      requestedModel: Option.some("gpt-6-astra"),
      costUsd: Option.some(0.02),
    }),
    turn("t3", 58_000, { status: 499, streamEnd: Option.none() }),
  ],
  // The first turn's one attempt served; the reviewer's failed turn went through
  // OpenRouter to a provider that was down; the fallback's first account was out of
  // budget. The turn its client left was kept before attempts were.
  attempts: [
    attempt("t1", 0, 0, 2_000, { accountLabel: Option.some("a@example.com") }),
    attempt("s2", 0, 20_000, 1_500, {
      provider: "openrouter",
      status: Option.some(502),
      outcome: "failed",
      category: Option.some("downstream_unavailable"),
      downstreamProvider: Option.some("Together"),
      message: Option.some("Provider returned error"),
    }),
    attempt("t2", 0, 40_000, 300, {
      accountLabel: Option.some("a@example.com"),
      status: Option.some(402),
      outcome: "failed",
      category: Option.some("budget_exhausted"),
      upstreamCode: Option.some("usage_limit_reached"),
      message: Option.some("You've hit your usage limit."),
    }),
    attempt("t2", 1, 40_300, 1_700, {
      provider: "opencode-go",
      model: "opencode-go/kimi-k3",
      accountLabel: Option.some("go main"),
    }),
  ],
};

/** Aider's, which sent no id: via guessed it. */
const aider: Conversation = {
  summary: conversation({
    id: "3f9a0c",
    source: "hash",
    guessed: true,
    client: Option.some("aider/0.86.1"),
    keyName: Option.none(),
    turns: 2,
    cost: cost(0, 0, ["local/llama"]),
    firstAt: T0 - 3_600_000,
    lastAt: T0 - 3_000_000,
  }),
  turns: [turn("a1", -3_600_000, { conversationId: Option.some("3f9a0c") })],
  attempts: [],
};

const seed = {
  historyBreakdown: new Map([["model", breakdown([group({ group: "gpt-6-astra" })])]]),
  conversations: [opencode, aider],
};

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
});

afterEach(() => vi.useRealTimers());

const rowsOf = (table: HTMLElement) => within(table).getAllByRole("row").slice(1);

/** The turns' bars in a timeline, each named "Turn <n>, …". */
const barsOf = (timeline: HTMLElement) =>
  within(timeline).getAllByRole("button", { name: /^Turn \d+,/ });

describe("the usage page's conversations", () => {
  it("keeps the requests on the first tab, so a plain link to Usage opens as before", async () => {
    renderApp("/usage", seed);

    const tab = await screen.findByRole("tab", { name: "Requests" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("table", { name: "Requests" })).toBeDefined();
  });

  it("opens the conversations on their own tab, kept in the URL", async () => {
    const { router, user } = renderApp("/usage", seed);

    await user.click(await screen.findByRole("tab", { name: "Conversations" }));

    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "conversations" }));
    expect(await screen.findByRole("table", { name: "Conversations" })).toBeDefined();
    // Grouping is what the totals are broken down by; conversations have none.
    expect(screen.queryByRole("radiogroup", { name: "Group by" })).toBeNull();
  });

  it("lists each conversation: its harness, key, models, turns, sub-agents, tokens and cost", async () => {
    renderApp("/usage?tab=conversations", seed);

    const [first, second] = rowsOf(await screen.findByRole("table", { name: "Conversations" }));

    expect(
      within(first ?? document.body).getByRole("link", { name: /OpenCode 1\.19\.3/ }),
    ).toBeDefined();
    expect(first?.textContent).toContain("laptop");
    expect(first?.textContent).toContain("gpt-6-astra");
    expect(first?.textContent).toContain("+1");
    expect(first?.textContent).toContain("1 sub-agent");
    expect(first?.textContent).toContain("1 failed");
    expect(first?.textContent).toContain("1 fell back");
    expect(first?.textContent).toContain("4.8K");
    expect(first?.textContent).toContain("$0.12");

    expect(second?.textContent).toContain("Aider 0.86.1");
    expect(second?.textContent).toContain("Unknown");
  });

  it("marks a conversation via guessed, and says why on hover", async () => {
    const { user } = renderApp("/usage?tab=conversations", seed);

    const [, second] = rowsOf(await screen.findByRole("table", { name: "Conversations" }));
    const badge = within(second ?? document.body).getByText("Guessed");

    await user.hover(badge);

    expect((await screen.findByRole("tooltip")).textContent).toContain("sent no conversation id");
  });

  it("asks for the conversations in the page's range, under its filters", async () => {
    const { state } = renderApp(
      "/usage?tab=conversations&range=7d&model=gpt-6-astra&failed=true",
      seed,
    );

    await screen.findByRole("table", { name: "Conversations" });

    const asked = state.historyQueries.find(
      (query) => !query.has("groupBy") && !query.has("bucket") && query.has("model"),
    );

    expect(asked?.get("model")).toBe("gpt-6-astra");
    expect(asked?.get("outcome")).toBe("error");
    expect(Number(asked?.get("to")) - Number(asked?.get("from"))).toBe(7 * 24 * 3_600_000);
  });

  it("loads more conversations on request", async () => {
    const many = Array.from({ length: 60 }, (_, i): Conversation => ({
      summary: conversation({ id: `ses_${i}`, lastAt: T0 - i * 1_000 }),
      turns: [],
      attempts: [],
    }));

    const { user } = renderApp("/usage?tab=conversations", { ...seed, conversations: many });

    const table = await screen.findByRole("table", { name: "Conversations" });
    expect(rowsOf(table)).toHaveLength(50);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rowsOf(table)).toHaveLength(60));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says when the range has no conversations", async () => {
    renderApp("/usage?tab=conversations", { ...seed, conversations: [] });

    expect(
      await screen.findByRole("heading", { name: "No conversations in the last day" }),
    ).toBeDefined();
  });

  it("fetches the conversations again as soon as via says the history changed", async () => {
    const { state } = renderApp("/usage?tab=conversations", seed);
    await screen.findByRole("table", { name: "Conversations" });

    const asked = () =>
      state.historyQueries.filter((query) => !query.has("groupBy") && !query.has("bucket")).length;

    const before = asked();
    act(() => openSource().history());

    await waitFor(() => expect(asked()).toBeGreaterThan(before));
  });
});

describe("a conversation", () => {
  it("opens from the list, at a URL of its own, and goes back to the list", async () => {
    const { router, user } = renderApp("/usage?tab=conversations", seed);

    await user.click(await screen.findByRole("link", { name: /OpenCode 1\.19\.3/ }));

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ tab: "conversations", conversation: "ses_1" }),
    );
    expect(await screen.findByRole("heading", { name: /OpenCode 1\.19\.3/ })).toBeDefined();

    await user.click(screen.getByRole("link", { name: "All conversations" }));

    await waitFor(() => expect(router.state.location.search).toEqual({ tab: "conversations" }));
    expect(await screen.findByRole("table", { name: "Conversations" })).toBeDefined();
  });

  it("opens from a link, its id escaped in the request", async () => {
    const claude: Conversation = {
      summary: conversation({ id: "ses:agent-1", client: Option.some("claude-cli/2.0.14") }),
      turns: [turn("c1", 0, { conversationId: Option.some("ses:agent-1") })],
      attempts: [],
    };

    const { state } = renderApp(
      `/usage?tab=conversations&conversation=${encodeURIComponent("ses:agent-1")}`,
      { ...seed, conversations: [claude] },
    );

    expect(await screen.findByRole("heading", { name: /Claude Code 2\.0\.14/ })).toBeDefined();
    expect(state.requests).toContain("GET /admin/history/conversations/ses%3Aagent-1");
  });

  it("draws each turn on one time axis, its sub-agent's under it, named for its type", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });
    const bars = barsOf(timeline);

    expect(bars.map((bar) => bar.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "Turn 1",
      "Turn 2",
      "Turn 3",
      "Turn 4",
      "Turn 5",
    ]);

    const review = within(timeline).getByRole("list", { name: "Sub-agent: review" });
    expect(barsOf(review)).toHaveLength(2);
  });

  it("says how each turn ended, in its bar's name", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });

    const names = within(timeline)
      .getAllByRole("button", { name: /^Turn \d+,/ })
      .map((bar) => bar.getAttribute("aria-label") ?? "");

    expect(names[0]).toContain("OK");
    expect(names[2]).toContain("Failed");
    expect(names[3]).toContain("Fell back");
    expect(names[4]).toContain("Client left");
  });

  it("shows a turn's detail while a bar has the pointer or focus", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });
    const [, , failedBar, fellBackBar] = barsOf(timeline);

    await user.hover(failedBar ?? timeline);
    const failure = await screen.findByRole("tooltip");
    expect(failure.textContent).toContain("upstream_unavailable");
    expect(failure.textContent).toContain("Codex is unreachable");
    await user.unhover(failedBar ?? timeline);

    act(() => fellBackBar?.focus());
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("go main"));
    const detail = screen.getByRole("tooltip").textContent ?? "";
    expect(detail).toContain("kimi-k3");
    expect(detail).toContain("Fell back from gpt-6-astra");
    expect(detail).toContain("2.0 s");
    expect(detail).toContain("500 ms");
    expect(detail).toContain("$0.02");
  });

  it("moves between bars with the arrow keys, as one stop for Tab", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });
    const bars = barsOf(timeline);

    expect(bars.filter((bar) => bar.tabIndex === 0)).toHaveLength(1);

    act(() => bars[0]?.focus());
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(bars[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(bars[4]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(bars[3]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(bars[0]);
  });

  it("flags a turn that took more than one attempt, or had one fail", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });

    const toggle = (number: number) =>
      within(timeline).queryByRole("button", {
        name: new RegExp(`^Attempts of turn ${number}\\b`),
      });

    expect(toggle(1)?.getAttribute("aria-label")).toBe("Attempts of turn 1");
    expect(toggle(3)?.getAttribute("aria-label")).toBe("Attempts of turn 3: 1, 1 failed");
    expect(toggle(4)?.getAttribute("aria-label")).toBe("Attempts of turn 4: 2, 1 failed");
    expect(toggle(4)?.textContent).toContain("2");
    // Kept before via kept attempts: there are none to show.
    expect(toggle(5)).toBeNull();
  });

  it("shows a turn's attempts on the same axis when opened, and why each didn't serve", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });
    const toggle = within(timeline).getByRole("button", { name: /^Attempts of turn 4\b/ });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Attempts of turn 4" })).toBeNull();

    act(() => toggle.focus());
    await user.keyboard("{Enter}");

    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const [budget, served] = within(
      screen.getByRole("list", { name: "Attempts of turn 4" }),
    ).getAllByRole("listitem");

    expect(budget?.textContent).toContain("Codex");
    expect(budget?.textContent).toContain("a@example.com");
    expect(budget?.textContent).toContain("402");
    expect(budget?.textContent).toContain("Budget exhausted");
    expect(budget?.textContent).toContain("usage_limit_reached");
    expect(budget?.textContent).toContain("You've hit your usage limit.");
    expect(served?.textContent).toContain("OpenCode Go");
    expect(served?.textContent).toContain("go main");
    expect(served?.textContent).toContain("Served");

    await user.click(toggle);
    expect(screen.queryByRole("list", { name: "Attempts of turn 4" })).toBeNull();
  });

  it("names the provider a router sent an attempt on to", async () => {
    const { user } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });
    await user.click(within(timeline).getByRole("button", { name: /^Attempts of turn 3\b/ }));

    const [down] = within(screen.getByRole("list", { name: "Attempts of turn 3" })).getAllByRole(
      "listitem",
    );

    expect(down?.textContent).toContain("OpenRouter → Together");
    expect(down?.textContent).toContain("Downstream unavailable");
    expect(down?.textContent).toContain("Provider returned error");
  });

  it("lists its turns, oldest first, with how each ended", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const table = await screen.findByRole("table", { name: "Turns" });
    const rows = rowsOf(table);

    expect(rows).toHaveLength(5);
    expect(rows[1]?.textContent).toContain("review");
    expect(rows[2]?.textContent).toContain("Unreachable");
  });

  it("says when via kept none of the conversation", async () => {
    renderApp("/usage?tab=conversations&conversation=gone", seed);

    expect(await screen.findByRole("heading", { name: "Conversation not found" })).toBeDefined();
    expect(screen.getByRole("link", { name: "All conversations" })).toBeDefined();
  });
});
