import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { TurnEvent } from "@via/server/admin-api";
import { Option } from "effect";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createLiveUpdates } from "../src/api/live.ts";
import { endedTurnsKey, liveTurnsKey } from "../src/api/turns.ts";
import { openSource } from "./event-source.ts";

type Turn = Extract<TurnEvent, { event: "turn.started" }>["data"];

type Attempt = Extract<TurnEvent, { event: "turn.attempt" }>["data"];

type Ended = Extract<TurnEvent, { event: "turn.ended" }>["data"];

/** When the turns start: now, as a turn in flight is never older than any turn runs. */
const T0 = Date.now();

const turn = (requestId: string): Turn => ({
  requestId,
  at: T0,
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
    queryClient,
    source: openSource(),
    turns: () => queryClient.getQueryData<ReadonlyArray<Turn>>(liveTurnsKey),
    /** The turns that ended which it holds still, by id. */
    held: () =>
      queryClient
        .getQueryData<ReadonlyArray<Ended>>(endedTurnsKey)
        ?.map(({ entry }) => entry.requestId) ?? [],
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

  it("keeps them however long no page shows them", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { source, turns } = listening();

    source.turn({ event: "turn.started", data: turn("r1") });
    vi.advanceTimersByTime(60 * 60_000);

    expect(turns()).toEqual([turn("r1")]);
  });

  it("holds a turn that ended until the history it is in has been fetched again", async () => {
    const { queryClient, source, held } = listening();
    let fetches = 0;

    // A page's list of requests, which a `history` event fetches again: r1 is in it once it ended.
    const observer = new QueryObserver(queryClient, {
      queryKey: ["history", "requests"],
      queryFn: () => {
        fetches += 1;

        return { pages: [{ requests: fetches > 1 ? [{ requestId: "r1" }] : [] }] };
      },
    });

    onTestFinished(observer.subscribe(() => {}));
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));

    source.turn({ event: "turn.started", data: turn("r1") });
    source.turn(ended("r1"));
    expect(held()).toEqual(["r1"]);

    source.history();
    expect(held()).toEqual(["r1"]);
    await vi.waitFor(() => expect(held()).toEqual([]));
    expect(fetches).toBe(2);
  });

  it("holds a turn that ended while the history fetched again lacks it", async () => {
    const { queryClient, source, held } = listening();
    let fetches = 0;

    const observer = new QueryObserver(queryClient, {
      queryKey: ["history", "requests"],
      queryFn: () => {
        fetches += 1;

        return { pages: [{ requests: [{ requestId: "r0" }] }] };
      },
    });

    onTestFinished(observer.subscribe(() => {}));
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));

    source.turn(ended("r1"));
    source.history();
    await vi.waitFor(() => expect(fetches).toBe(2));

    expect(held()).toEqual(["r1"]);
  });

  it("holds a turn that ended when fetching the history again fails", async () => {
    const { queryClient, source, held } = listening();
    let fetches = 0;

    const observer = new QueryObserver(queryClient, {
      queryKey: ["history", "conversation", "ses_1"],
      queryFn: () => {
        fetches += 1;

        return fetches > 1 ? Promise.reject(new Error("via is down")) : { turns: [] };
      },
      retry: false,
    });

    onTestFinished(observer.subscribe(() => {}));
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));

    source.turn(ended("r1"));
    source.history();
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));

    expect(held()).toEqual(["r1"]);
  });

  it("holds a turn that ended while a list read further holds still", async () => {
    const { queryClient, source, held } = listening();

    // A list of conversations with two pages loaded, which a `history` event leaves be.
    queryClient.setQueryData(["history", "conversations"], {
      pages: [{ conversations: [] }, { conversations: [] }],
      pageParams: [undefined, 1],
    });

    source.turn(ended("r1"));
    source.history();
    await Promise.resolve();

    expect(held()).toEqual(["r1"]);
  });

  it("lets go of a turn that ended once the list of conversations has its conversation", async () => {
    const { queryClient, source, held } = listening();

    source.turn(ended("r1"));
    await queryClient.fetchQuery({
      queryKey: ["history", "conversations"],
      queryFn: () => ({ pages: [{ conversations: [{ id: "ses_1" }] }], pageParams: [undefined] }),
    });

    expect(held()).toEqual([]);
  });

  it("holds the turns that ended when the stream drops, as the history may not have them yet", () => {
    const { source, held } = listening();

    source.turn(ended("r1"));
    source.fail();

    expect(held()).toEqual(["r1"]);
  });
});
