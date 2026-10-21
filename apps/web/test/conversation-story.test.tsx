import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { LiveTurn, TurnAttempt, UsageRequest } from "../src/api/types.ts";
import { ConversationStory } from "../src/components/conversation-story.tsx";
import { timelineOf } from "../src/lib/timeline.ts";
import { attempt, liveTurn, openAttempt, request } from "../src/testing/history.ts";

const T0 = Date.parse("2026-09-27T11:30:00.000Z");

const turn = (requestId: string, at: number, fields: Partial<UsageRequest> = {}) =>
  request({
    requestId,
    at: T0 + at,
    durationMs: 2_000,
    firstChunkMs: Option.some(500),
    conversationId: Option.some("root"),
    ...fields,
  });

const unreachable = {
  status: 503,
  error: Option.some("upstream_unavailable"),
  errorMessage: Option.some("Endpoint is unavailable"),
  streamEnd: Option.none(),
  inputTokens: Option.none(),
  outputTokens: Option.none(),
} satisfies Partial<UsageRequest>;

const failedAttempt = (requestId: string, at: number, fields: Partial<TurnAttempt> = {}) =>
  attempt({
    requestId,
    startedAt: T0 + at,
    durationMs: 300,
    status: Option.some(402),
    outcome: "failed",
    category: Option.some("budget_exhausted"),
    upstreamCode: Option.some("usage_limit_reached"),
    accountLabel: Option.some("a@example.com"),
    message: Option.some("You've hit your usage limit."),
    ...fields,
  });

const show = (
  turns: ReadonlyArray<UsageRequest>,
  {
    attempts = [],
    live = [],
    now = T0 + 120_000,
    captured = new Set<string>(),
    onViewRequest = () => {},
  }: {
    readonly attempts?: ReadonlyArray<TurnAttempt>;
    readonly live?: ReadonlyArray<LiveTurn>;
    readonly now?: number;
    readonly captured?: ReadonlySet<string>;
    readonly onViewRequest?: (requestId: string, number: number) => void;
  } = {},
) =>
  render(
    <ConversationStory
      timeline={timelineOf("root", turns, { attempts, live, now })}
      now={now}
      captured={captured}
      onViewRequest={onViewRequest}
    />,
  );

const story = () => screen.getByRole("list", { name: "Timeline" });

describe("ConversationStory", () => {
  it("sums the conversation up in a sentence", () => {
    show([turn("a", 0), turn("b", 4_000, unreachable), turn("c", 94_000, { model: "kimi-k3" })]);

    const headline = screen.getByText("3 turns over 1.6 min").parentElement;
    expect(headline?.textContent).toContain("6.0 s of model time · 2 models · 1 failed");
  });

  it("folds turns that went fine on one model into a line that opens on them", async () => {
    const user = userEvent.setup();

    show([turn("a", 0), turn("b", 2_000), turn("c", 4_000, { durationMs: 1_500 })]);

    const fold = within(story()).getByRole("button", { name: /^Turns 1–3/ });
    expect(fold.textContent).toContain("gpt-6-astra");
    expect(fold.textContent).toContain("all OK");
    expect(fold.textContent).toContain("5.5 s");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Turns 1–3" })).toBeNull();

    await user.click(fold);

    expect(fold.getAttribute("aria-expanded")).toBe("true");
    const rows = within(screen.getByRole("list", { name: "Turns 1–3" })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[2]?.textContent).toContain("1.5 s");
    expect(rows[2]?.textContent).toContain("gpt-6-astra");
    expect(rows[2]?.textContent).toContain("work@example.com");
  });

  it("merges failures in a row into one card, with the message the upstream sent", () => {
    show([turn("a", 0, unreachable), turn("b", 2_000, { ...unreachable, durationMs: 1_300 })]);

    const card = within(story()).getByRole("article", { name: /^Turns 1–2/ });
    expect(card.textContent).toContain("2 failed in a row");
    expect(card.textContent).toContain("503 · Unreachable");
    expect(card.textContent).toContain("Endpoint is unavailable");
    expect(card.textContent).toContain("Turn 2");
    expect(card.textContent).toContain("0:02");
    expect(card.textContent).toContain("1.3 s");
  });

  it("marks a stretch with nothing running, and a switch of model", () => {
    show([turn("a", 0), turn("b", 6_700, { model: "kimi-k3" })]);

    expect(within(story()).getByText("4.7 s idle")).toBeDefined();
    expect(within(story()).getByText("Switched to")).toBeDefined();
    expect(within(story()).getAllByText("kimi-k3").length).toBeGreaterThan(0);
  });

  it("threads a sub-agent's turns under a header of its own", () => {
    show([
      turn("a", 0),
      turn("s1", 1_000, {
        conversationId: Option.some("child"),
        parentConversationId: Option.some("root"),
        agentType: Option.some("review"),
      }),
      turn("s2", 3_000, {
        conversationId: Option.some("child"),
        parentConversationId: Option.some("root"),
        agentType: Option.some("review"),
      }),
    ]);

    const thread = within(story()).getByRole("list", { name: "Sub-agent: review" });
    expect(within(thread).getAllByRole("listitem")).toHaveLength(2);
    expect(thread.closest("li")?.textContent).toContain("2 turns · 4.0 s · 0:01–0:05");
  });

  it("names the turns a sub-agent's fold and failures hold, when others came between", () => {
    const sub = (requestId: string, at: number, fields: Partial<UsageRequest> = {}) =>
      turn(requestId, at, {
        conversationId: Option.some("child"),
        parentConversationId: Option.some("root"),
        ...fields,
      });

    show([
      turn("a", 0),
      sub("s1", 10_000),
      turn("b", 11_000),
      sub("s2", 12_000),
      sub("s3", 14_000),
      sub("f1", 20_000, unreachable),
      turn("c", 21_000),
      sub("f2", 23_000, unreachable),
    ]);

    const thread = within(story()).getByRole("list", { name: "Sub-agent" });
    expect(within(thread).getByRole("button", { name: /^Turns 2, 4–5 gpt/ })).toBeDefined();
    expect(within(thread).getByRole("article", { name: /^Turns 6, 8,/ })).toBeDefined();
  });

  it("names a sub-agent of no type plainly", () => {
    show([
      turn("a", 0),
      turn("s", 1_000, {
        conversationId: Option.some("child"),
        parentConversationId: Option.some("root"),
      }),
    ]);

    expect(within(story()).getByRole("list", { name: "Sub-agent" })).toBeDefined();
  });

  it("opens a card's attempts: where each went, and why it didn't serve", async () => {
    const user = userEvent.setup();

    show(
      [
        turn("a", 0, {
          model: "kimi-k3",
          provider: "opencode-go",
          requestedModel: Option.some("gpt-6-astra"),
        }),
      ],
      {
        attempts: [
          failedAttempt("a", 0),
          attempt({
            requestId: "a",
            seq: 1,
            startedAt: T0 + 300,
            durationMs: 1_700,
            provider: "opencode-go",
            model: "opencode-go/kimi-k3",
            accountLabel: Option.some("go main"),
          }),
        ],
      },
    );

    const card = within(story()).getByRole("article", { name: /^Turn 1/ });
    expect(card.textContent).toContain("Fell back from gpt-6-astra");

    const toggle = within(card).getByRole("button", { name: "Attempts of turn 1: 2, 1 failed" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(toggle);

    const [budget, served] = within(
      screen.getByRole("list", { name: "Attempts of turn 1" }),
    ).getAllByRole("listitem");

    expect(budget?.textContent).toContain("Codex");
    expect(budget?.textContent).toContain("a@example.com");
    expect(budget?.textContent).toContain("402");
    expect(budget?.textContent).toContain("Budget exhausted");
    expect(budget?.textContent).toContain("usage_limit_reached");
    expect(budget?.textContent).toContain("You've hit your usage limit.");
    expect(budget?.textContent).toContain("300 ms");
    expect(served?.textContent).toContain("OpenCode Go");
    expect(served?.textContent).toContain("go main");
    expect(served?.textContent).toContain("Served");
  });

  it("names the provider a router sent an attempt on to", async () => {
    const user = userEvent.setup();

    show([turn("a", 0, unreachable)], {
      attempts: [
        failedAttempt("a", 0, {
          provider: "openrouter",
          status: Option.some(502),
          category: Option.some("downstream_unavailable"),
          downstreamProvider: Option.some("Together"),
        }),
      ],
    });

    await user.click(within(story()).getByRole("button", { name: /^Attempts of turn 1\b/ }));

    expect(screen.getByRole("list", { name: "Attempts of turn 1" }).textContent).toContain(
      "OpenRouter → Together",
    );
  });

  it("offers a failed turn's kept request", async () => {
    const user = userEvent.setup();
    const view = vi.fn();

    show([turn("a", 0), turn("b", 2_000, unreachable), turn("c", 4_000, unreachable)], {
      captured: new Set(["c"]),
      onViewRequest: view,
    });

    const card = within(story()).getByRole("article", { name: /^Turns 2–3/ });
    const buttons = within(card).getAllByRole("button", { name: "View request" });
    expect(buttons).toHaveLength(1);

    await user.click(buttons[0] ?? card);
    expect(view).toHaveBeenCalledWith("c", 3);
  });

  it("shows a turn in flight on a card: how long so far, and its attempts", () => {
    const now = T0 + 9_000;

    show([turn("a", 0)], {
      now,
      live: [
        liveTurn({
          requestId: "l",
          at: T0 + 4_000,
          conversationId: Option.some("root"),
          attempts: [
            openAttempt({
              requestId: "l",
              startedAt: T0 + 4_000,
              accountLabel: Option.some("a@example.com"),
              firstChunkMs: Option.some(1_200),
            }),
          ],
        }),
      ],
    });

    expect(screen.getByText(/one still streaming/)).toBeDefined();

    const card = within(story()).getByRole("article", { name: /^Turn 2, gpt-6-astra, in flight/ });
    expect(card.textContent).toContain("5.0 s so far");
    expect(card.textContent).toContain("1.2 s to first token");

    const [open] = within(
      within(card).getByRole("list", { name: "Attempts of turn 2" }),
    ).getAllByRole("listitem");

    expect(open?.textContent).toContain("a@example.com");
    expect(open?.textContent).toContain("In flight");
  });
});
