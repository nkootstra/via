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
  liveTurn,
  openAttempt,
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
  captured: [],
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
  captured: [],
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

/** The entry of turn `number` in a story: its card, or the line it has to itself. */
const entryOf = (story: HTMLElement, number: number) =>
  within(story).queryByRole("article", { name: new RegExp(`^Turn ${number},`) }) ??
  within(story)
    .getByText((_, element) => element?.textContent === `Turn ${number}`, { selector: "span" })
    .closest("li");

/** What the entry of turn `number` says, once there is one. */
const entryText = async (story: HTMLElement, number: number) => {
  await waitFor(() => expect(entryOf(story, number)).not.toBeNull());

  return entryOf(story, number)?.textContent ?? "";
};

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
      captured: [],
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

  it("marks a conversation with a turn in flight, its sub-agents' included, as live", async () => {
    renderApp("/usage?tab=conversations", seed);
    const table = await screen.findByRole("table", { name: "Conversations" });

    act(() =>
      openSource().turn({
        event: "turn.started",
        data: liveTurn({
          requestId: "l1",
          conversationId: Option.some("ses_1:explore"),
          parentConversationId: Option.some("ses_1"),
        }),
      }),
    );

    await waitFor(() =>
      expect(within(rowsOf(table)[0] ?? table).queryByText("Live")).not.toBeNull(),
    );
    expect(within(rowsOf(table)[1] ?? table).queryByText("Live")).toBeNull();
    expect(rowsOf(table)).toHaveLength(2);
  });

  it("puts a conversation whose first turn is in flight at the top, until the history has it", async () => {
    const { state } = renderApp("/usage?tab=conversations", seed);
    const table = await screen.findByRole("table", { name: "Conversations" });
    const source = openSource();

    act(() =>
      source.turn({
        event: "turn.started",
        data: liveTurn({
          requestId: "l1",
          conversationId: Option.some("ses_new"),
          client: Option.some("claude-cli/2.0.14"),
        }),
      }),
    );

    await waitFor(() => expect(rowsOf(table)).toHaveLength(3));
    const [fresh] = rowsOf(table);
    expect(fresh?.textContent).toContain("Claude Code 2.0.14");
    expect(within(fresh ?? table).getByText("Live")).toBeDefined();
    expect(
      within(fresh ?? table)
        .getByRole("link")
        .getAttribute("href"),
    ).toContain("conversation=ses_new");

    // It ends: it stays, no longer live, until the history has it.
    const entry = turn("l1", now.getTime() - 5_000 - T0, {
      conversationId: Option.some("ses_new"),
      client: Option.some("claude-cli/2.0.14"),
    });

    act(() => source.turn({ event: "turn.ended", data: { entry, attempts: [] } }));
    await waitFor(() => expect(within(rowsOf(table)[0] ?? table).queryByText("Live")).toBeNull());
    expect(rowsOf(table)[0]?.textContent).toContain("Claude Code 2.0.14");

    state.conversations = [
      {
        summary: conversation({
          id: "ses_new",
          client: Option.some("claude-cli/2.0.14"),
          lastAt: entry.at,
        }),
        turns: [entry],
        attempts: [],
        captured: [],
      },
      opencode,
      aider,
    ];
    act(() => source.history());

    await waitFor(() => expect(rowsOf(table)[0]?.textContent).toContain("$0.12"));
    expect(rowsOf(table)).toHaveLength(3);
  });

  it("leaves a conversation whose first turn is in flight out of a filtered list", async () => {
    renderApp("/usage?tab=conversations&model=gpt-6-astra", seed);
    const table = await screen.findByRole("table", { name: "Conversations" });

    act(() =>
      openSource().turn({
        event: "turn.started",
        data: liveTurn({ requestId: "l1", conversationId: Option.some("ses_new") }),
      }),
    );
    act(() => openSource().turn({ event: "turn.started", data: liveTurn({ requestId: "l2" }) }));

    await waitFor(() => expect(within(table).queryByText("Live")).not.toBeNull());
    expect(rowsOf(table)).toHaveLength(2);
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
      captured: [],
    };

    const { state } = renderApp(
      `/usage?tab=conversations&conversation=${encodeURIComponent("ses:agent-1")}`,
      { ...seed, conversations: [claude] },
    );

    expect(await screen.findByRole("heading", { name: /Claude Code 2\.0\.14/ })).toBeDefined();
    expect(state.requests).toContain("GET /admin/history/conversations/ses%3Aagent-1");
  });

  it("tells each turn down the story, its sub-agent's in a thread named for its type", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const story = await screen.findByRole("list", { name: "Timeline" });

    for (const number of [1, 2, 3, 4, 5]) expect(entryOf(story, number)).not.toBeNull();

    const review = within(story).getByRole("list", { name: "Sub-agent: review" });
    expect(entryOf(review, 2)).not.toBeNull();
    expect(entryOf(review, 3)).not.toBeNull();
    expect(within(story).getByText("18.0 s idle")).toBeDefined();
  });

  it("gives each turn that didn't simply go fine a card that says how it ended", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const story = await screen.findByRole("list", { name: "Timeline" });

    const card = (number: number) =>
      within(story).getByRole("article", { name: new RegExp(`^Turn ${number},`) });

    expect(card(3).getAttribute("aria-label")).toContain("Failed");
    expect(card(4).getAttribute("aria-label")).toContain("Fell back");
    expect(card(5).getAttribute("aria-label")).toContain("Client left");
    expect(within(story).queryByRole("article", { name: /^Turn 1,/ })).toBeNull();
  });

  it("says on a turn's card why it failed, and who served one that fell back", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const story = await screen.findByRole("list", { name: "Timeline" });

    const failure = await entryText(story, 3);
    expect(failure).toContain("502 · Downstream unavailable");
    expect(failure).toContain("Provider returned error");

    const fellBack = await entryText(story, 4);
    expect(fellBack).toContain("go main");
    expect(fellBack).toContain("kimi-k3");
    expect(fellBack).toContain("Fell back from gpt-6-astra");
    expect(fellBack).toContain("2.0 s");
    expect(fellBack).toContain("500 ms");
    expect(fellBack).toContain("$0.02");
  });

  it("flags a turn that took more than one attempt, or had one fail", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);

    const timeline = await screen.findByRole("list", { name: "Timeline" });

    const toggle = (number: number) =>
      within(timeline).queryByRole("button", {
        name: new RegExp(`^Attempts of turn ${number}\\b`),
      });

    // A turn that simply went fine has a line, not a card to open.
    expect(toggle(1)).toBeNull();
    expect(toggle(3)?.getAttribute("aria-label")).toBe("Attempts of turn 3: 1, 1 failed");
    expect(toggle(4)?.getAttribute("aria-label")).toBe("Attempts of turn 4: 2, 1 failed");
    expect(toggle(4)?.textContent).toContain("1 failed");
    // Kept before via kept attempts: there are none to show.
    expect(toggle(5)).toBeNull();
  });

  it("shows a turn's attempts when opened, and why each didn't serve", async () => {
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

/** A turn of ses_1 that came in five seconds before the tests' clock, and ended a second later. */
const kept = turn("l1", now.getTime() - 5_000 - T0, { durationMs: 1_000 });

describe("a conversation, while a turn is in flight", () => {
  it("shows the turn on a card, up to now, with its attempt under way", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    const story = await screen.findByRole("list", { name: "Timeline" });

    act(() => openSource().turn({ event: "turn.started", data: liveTurn({ requestId: "l1" }) }));
    act(() =>
      openSource().turn({
        event: "turn.attempt",
        data: openAttempt({ requestId: "l1", accountLabel: Option.some("a@example.com") }),
      }),
    );

    const card = await within(story).findByRole("article", {
      name: /^Turn 6, gpt-6-astra, in flight/,
    });

    await waitFor(() => expect(card.textContent).toContain("5.0 s so far"));

    const [open] = within(
      await within(card).findByRole("list", { name: "Attempts of turn 6" }),
    ).getAllByRole("listitem");

    expect(open?.textContent).toContain("a@example.com");
    expect(open?.textContent).toContain("In flight");
  });

  it("puts the kept turn in its place as it ends, before the history is fetched again", async () => {
    const { state } = renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    const story = await screen.findByRole("list", { name: "Timeline" });
    const source = openSource();

    act(() => source.turn({ event: "turn.started", data: liveTurn({ requestId: "l1" }) }));
    expect(
      await within(story).findByRole("article", { name: /^Turn 6,.*in flight/ }),
    ).toBeDefined();
    const asked = state.requests.length;

    act(() =>
      source.turn({
        event: "turn.ended",
        data: { entry: kept, attempts: [keptAttempt({ requestId: "l1" })] },
      }),
    );

    // It went fine: it leaves its card for a line of its own.
    await waitFor(() =>
      expect(within(story).queryByRole("article", { name: /^Turn 6,/ })).toBeNull(),
    );
    expect(await entryText(story, 6)).toContain("1.0 s");
    expect(state.requests.length).toBe(asked);

    // The history has it now, and says so.
    state.conversations = [{ ...opencode, turns: [...opencode.turns, kept] }, aider];
    act(() => source.history());

    await waitFor(() => expect(state.requests.length).toBeGreaterThan(asked));
    expect(await entryText(story, 6)).toContain("1.0 s");
    expect(within(story).queryByText((_, element) => element?.textContent === "Turn 7")).toBeNull();
  });

  it("nests a sub-agent's turn in flight under the conversation that started it", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    const timeline = await screen.findByRole("list", { name: "Timeline" });

    act(() =>
      openSource().turn({
        event: "turn.started",
        data: liveTurn({
          requestId: "l1",
          conversationId: Option.some("ses_1:explore"),
          parentConversationId: Option.some("ses_1"),
          agentType: Option.some("explore"),
        }),
      }),
    );

    const explore = await within(timeline).findByRole("list", { name: "Sub-agent: explore" });
    expect(within(explore).getByRole("article", { name: /^Turn 6,.*in flight/ })).toBeDefined();
  });

  it("leaves out another conversation's turns in flight", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_1", seed);
    const timeline = await screen.findByRole("list", { name: "Timeline" });

    act(() =>
      openSource().turn({
        event: "turn.started",
        data: liveTurn({ requestId: "x1", conversationId: Option.some("ses_2") }),
      }),
    );
    act(() => openSource().turn({ event: "turn.started", data: liveTurn({ requestId: "l1" }) }));

    expect(
      await within(timeline).findByRole("article", { name: /^Turn 6,.*in flight/ }),
    ).toBeDefined();
    expect(within(timeline).queryByRole("article", { name: /^Turn 7,/ })).toBeNull();
  });

  it("opens a conversation whose first turn is still in flight", async () => {
    renderApp("/usage?tab=conversations&conversation=ses_new", seed);
    await screen.findByRole("heading", { name: "Conversation not found" });

    act(() =>
      openSource().turn({
        event: "turn.started",
        data: liveTurn({
          requestId: "l1",
          conversationId: Option.some("ses_new"),
          client: Option.some("claude-cli/2.0.14"),
        }),
      }),
    );

    expect(await screen.findByRole("heading", { name: /Claude Code 2\.0\.14/ })).toBeDefined();
    expect(
      await within(screen.getByRole("list", { name: "Timeline" })).findByRole("article", {
        name: /^Turn 1,.*in flight/,
      }),
    ).toBeDefined();
  });
});
