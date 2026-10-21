import { QueryClient } from "@tanstack/react-query";
import type { TurnEvent } from "@via/server/admin-api";
import { Option } from "effect";
import { describe, expect, it, onTestFinished } from "vitest";
import { createLiveUpdates } from "../src/api/live.ts";
import { liveTurnsKey } from "../src/api/turns.ts";
import { openSource } from "./event-source.ts";

type Turn = Extract<TurnEvent, { event: "turn.started" }>["data"];

type Attempt = Extract<TurnEvent, { event: "turn.attempt" }>["data"];

const turn = (requestId: string): Turn => ({
  requestId,
  at: 1_000,
  model: "gpt-6-astra",
  conversationId: Option.some("ses_1"),
  parentConversationId: Option.none(),
  agentType: Option.none(),
  client: Option.some("opencode/1.19.3"),
  keyName: Option.some("laptop"),
  attempts: [],
});

const open = (requestId: string, seq: number): Attempt => ({
  state: "open",
  requestId,
  seq,
  startedAt: 1_000 + seq,
  provider: "codex",
  model: "gpt-6-astra",
  accountId: Option.some("acc-a"),
  accountLabel: Option.some("a@example.com"),
  status: Option.none(),
  firstChunkMs: Option.none(),
});

const ended = (requestId: string): TurnEvent => ({
  event: "turn.ended",
  data: {
    entry: {
      requestId,
      at: 1_000,
      status: 200,
      error: Option.none(),
      errorMessage: Option.none(),
      streamEnd: Option.none(),
      keyId: Option.none(),
      keyName: Option.none(),
      model: "gpt-6-astra",
      provider: "codex",
      accountId: Option.none(),
      accountLabel: Option.none(),
      inputTokens: Option.none(),
      cachedTokens: Option.none(),
      cacheWriteTokens: Option.none(),
      outputTokens: Option.none(),
      reasoningTokens: Option.none(),
      costUsd: Option.none(),
      durationMs: 10,
      firstChunkMs: Option.none(),
      requestedModel: Option.none(),
      fallbackReason: Option.none(),
      conversationId: Option.some("ses_1"),
      parentConversationId: Option.none(),
      sessionSource: Option.none(),
      agentType: Option.none(),
      client: Option.none(),
    },
    attempts: [],
  },
});

/** Listens as a page does, and answers the turns in flight it holds after each change. */
const listening = () => {
  const queryClient = new QueryClient();
  const stop = createLiveUpdates(queryClient).start();
  onTestFinished(stop);

  return {
    source: openSource(),
    turns: () => queryClient.getQueryData<ReadonlyArray<Turn>>(liveTurnsKey),
  };
};

describe("the turns in flight", () => {
  it("holds each turn from its start to its end, with its attempts as they stand", () => {
    const { source, turns } = listening();

    source.turn({ event: "turn.started", data: turn("r1") });
    source.turn({ event: "turn.started", data: turn("r2") });
    source.turn({ event: "turn.attempt", data: open("r1", 0) });
    source.turn({ event: "turn.attempt", data: { ...open("r1", 0), status: Option.some(200) } });

    expect(turns()).toEqual([
      { ...turn("r1"), attempts: [{ ...open("r1", 0), status: Option.some(200) }] },
      turn("r2"),
    ]);

    source.turn(ended("r1"));
    expect(turns()).toEqual([turn("r2")]);
  });

  it("lets go of them when the stream drops, as via sends those still in flight once back", () => {
    const { source, turns } = listening();

    source.turn({ event: "turn.started", data: turn("r1") });
    source.fail();
    expect(turns()).toEqual([]);
  });
});
