import { Arbitrary, Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { TurnAttempt, UsageRequest } from "../src/api/types.ts";
import {
  FOLD_MIN,
  IDLE_MS,
  clockOffset,
  storyOf,
  storySummary,
  type StoryItem,
} from "../src/lib/story.ts";
import { type TimelineItem, type TimelineTurn, timelineOf } from "../src/lib/timeline.ts";
import { attempt, liveTurn, openAttempt, request } from "../src/testing/history.ts";

const T0 = Date.parse("2026-09-27T11:00:00.000Z");

const turn = (requestId: string, at: number, fields: Partial<UsageRequest> = {}) =>
  request({
    requestId,
    at: T0 + at,
    durationMs: 1_000,
    firstChunkMs: Option.some(250),
    conversationId: Option.some("root"),
    ...fields,
  });

const failed503 = {
  status: 503,
  error: Option.some("upstream_unavailable"),
  streamEnd: Option.none(),
  inputTokens: Option.none(),
  outputTokens: Option.none(),
} satisfies Partial<UsageRequest>;

const sub = (requestId: string, at: number, fields: Partial<UsageRequest> = {}) =>
  turn(requestId, at, {
    conversationId: Option.some("child"),
    parentConversationId: Option.some("root"),
    agentType: Option.some("explore"),
    ...fields,
  });

const story = (
  turns: ReadonlyArray<UsageRequest>,
  extra: Parameters<typeof timelineOf>[2] = {},
  now = 0,
) => storyOf(timelineOf("root", turns, { ...extra, now }).items, now);

/** What each item is, in a word, and its turns' ids: a story at a glance. */
const glance = (items: ReadonlyArray<StoryItem>): ReadonlyArray<string> =>
  items.map((item) => {
    switch (item.kind) {
      case "idle":
        return `idle ${item.ms}`;
      case "switch":
        return `switch ${item.to}`;
      case "turn":
        return `${item.card ? "card" : "line"} ${item.turn.turn.requestId}`;
      case "run":
      case "failures":
        return `${item.kind} ${item.turns.map((row) => row.turn.requestId).join(",")}`;
      case "agent":
        return `agent [${glance(item.items).join("; ")}]`;
    }
  });

/** An attempt of `requestId` that failed, from `at` (after T0). */
const failedAttempt = (requestId: string, at: number, fields: Partial<TurnAttempt>) =>
  attempt({
    requestId,
    startedAt: T0 + at,
    durationMs: 1_000,
    status: Option.some(429),
    outcome: "failed",
    ...fields,
  });

describe("storyOf", () => {
  it(`folds a run of ${FOLD_MIN} or more turns that went fine on one model into one line`, () => {
    expect(glance(story([turn("a", 0), turn("b", 1_000), turn("c", 2_000)]))).toEqual([
      "run a,b,c",
    ]);
    expect(glance(story([turn("a", 0), turn("b", 1_000)]))).toEqual(["line a", "line b"]);
  });

  it("gives a turn that failed, fell back, was left or took retries a card of its own", () => {
    const items = story(
      [
        turn("a", 0),
        turn("b", 1_000),
        turn("c", 2_000, failed503),
        turn("d", 3_000, { requestedModel: Option.some("gpt-6-astra"), model: "kimi-k3" }),
        turn("e", 4_000, { status: 499, streamEnd: Option.none() }),
        turn("f", 5_000),
      ],
      {
        attempts: [
          attempt({ requestId: "f", startedAt: T0 + 5_000, durationMs: 200, outcome: "failed" }),
          attempt({ requestId: "f", seq: 1, startedAt: T0 + 5_200, durationMs: 800 }),
        ],
      },
    );

    expect(glance(items)).toEqual(["line a", "line b", "card c", "card d", "card e", "card f"]);
  });

  it("merges failures in a row that failed the same way, on the same model", () => {
    const items = story([
      turn("a", 0, failed503),
      turn("b", 1_000, failed503),
      turn("c", 2_000, failed503),
      turn("d", 3_000, { ...failed503, status: 502 }),
      turn("e", 4_000, { ...failed503, model: "kimi-k3", requestedModel: Option.none() }),
    ]);

    expect(glance(items)).toEqual(["failures a,b,c", "card d", "switch kimi-k3", "card e"]);
  });

  it("tells failures apart by what their failed attempt said", () => {
    const items = story([turn("a", 0, failed503), turn("b", 1_000, failed503)], {
      attempts: [
        failedAttempt("a", 0, { category: Option.some("rate_limited") }),
        failedAttempt("b", 1_000, { category: Option.some("budget_exhausted") }),
      ],
    });

    expect(glance(items)).toEqual(["card a", "card b"]);
  });

  it(`marks a stretch of more than ${IDLE_MS / 1_000} s with nothing running, between items`, () => {
    const items = story([
      turn("a", 0),
      turn("b", 1_000 + IDLE_MS),
      turn("c", 2_000 + 2 * IDLE_MS + 4_700),
    ]);

    expect(glance(items)).toEqual(["line a", "line b", `idle ${IDLE_MS + 4_700}`, "line c"]);
  });

  it("keeps failures apart across a stretch of idle time", () => {
    const items = story([turn("a", 0, failed503), turn("b", 10_000, failed503)]);

    expect(glance(items)).toEqual(["card a", "idle 9000", "card b"]);
  });

  it("marks where the model the client asked for changes, and not where via fell back", () => {
    const items = story([
      turn("a", 0),
      turn("b", 1_000, { model: "kimi-k3", requestedModel: Option.some("gpt-6-astra") }),
      turn("c", 2_000, { model: "kimi-k3" }),
      turn("d", 3_000, { model: "kimi-k3" }),
      turn("e", 4_000, { model: "kimi-k3" }),
    ]);

    expect(glance(items)).toEqual(["line a", "card b", "switch kimi-k3", "run c,d,e"]);
  });

  it("threads a sub-agent's turns under it, with when it ran", () => {
    const items = story([turn("a", 0), sub("s1", 500), sub("s2", 1_600), turn("b", 3_000)]);

    expect(glance(items)).toEqual(["line a", "agent [line s1; line s2]", "line b"]);

    const agent = items[1];
    expect(agent?.kind === "agent" && [agent.from - T0, agent.to - T0, agent.turns]).toEqual([
      500, 2_600, 2,
    ]);
  });

  it("gives a turn in flight a card, running to now, never folded", () => {
    const items = story(
      [turn("a", 0), turn("b", 1_000)],
      { live: [liveTurn({ requestId: "l", at: T0 + 2_000, conversationId: Option.some("root") })] },
      T0 + 6_000,
    );

    expect(glance(items)).toEqual(["line a", "line b", "card l"]);
  });
});

describe("clockOffset", () => {
  it("reads as a clock from the conversation's start", () => {
    expect(clockOffset(0)).toBe("0:00");
    expect(clockOffset(9_400)).toBe("0:09");
    expect(clockOffset(86_000)).toBe("1:26");
    expect(clockOffset(3_723_000)).toBe("1:02:03");
    expect(clockOffset(-50)).toBe("0:00");
  });
});

describe("storySummary", () => {
  it("counts the turns, the time they took, the models, the failures and the turns in flight", () => {
    const now = T0 + 96_000;

    const live = liveTurn({
      requestId: "l",
      at: T0 + 90_000,
      model: "kimi-k3",
      conversationId: Option.some("root"),
      attempts: [
        openAttempt({ requestId: "l", startedAt: T0 + 90_000, firstChunkMs: Option.some(1_000) }),
      ],
    });

    const summary = storySummary(
      timelineOf("root", [turn("a", 0), turn("b", 2_000, failed503), sub("s", 3_000)], {
        live: [live],
        now,
      }),
      now,
    );

    expect(summary).toEqual({
      turns: 4,
      spanMs: 96_000,
      busyMs: 9_000,
      models: 2,
      failed: 1,
      live: 1,
      streaming: 1,
    });
  });
});

/** The turns a story tells, in the order it tells them. */
const told = (items: ReadonlyArray<StoryItem>): ReadonlyArray<TimelineTurn> =>
  items.flatMap((item) => {
    switch (item.kind) {
      case "turn":
        return [item.turn];
      case "run":
      case "failures":
        return item.turns;
      case "agent":
        return told(item.items);
      default:
        return [];
    }
  });

const flatten = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<TimelineTurn> =>
  items.flatMap((item) => (item.kind === "turn" ? [item] : flatten(item.items)));

/** Each list in a story: its own, and each thread's. */
const lists = (items: ReadonlyArray<StoryItem>): ReadonlyArray<ReadonlyArray<StoryItem>> => [
  items,
  ...items.flatMap((item) => (item.kind === "agent" ? lists(item.items) : [])),
];

/** Checks `property` over generated values, failing with the shrunk counterexample. */
const holds = <A>(values: Arbitrary.Arbitrary<A>, property: (value: A) => boolean) => {
  const result = Effect.runSync(Arbitrary.checkEffect(values, property));

  expect(Arbitrary.formatCheckFailure(result)).toBeUndefined();
};

const Turn = Schema.Struct({
  after: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 * IDLE_MS })),
  durationMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 * IDLE_MS })),
  model: Schema.Literals(["gpt-6-astra", "kimi-k3"]),
  ended: Schema.Literals(["ok", "503", "502", "left", "fellBack", "retried"]),
  agent: Schema.Literals(["root", "explore", "review"]),
});

const Conversation = Schema.Struct({
  turns: Schema.Array(Turn).check(Schema.isMaxLength(24)),
  live: Schema.Boolean,
});

type Generated = typeof Conversation.Type;

/** A generated conversation as its story: turns one after another, some a sub-agent's. */
const generated = ({ turns, live }: Generated) => {
  let at = T0;

  const requests = turns.map((spec, index) => {
    at += spec.after;
    const id = `t${index}`;

    return turn(id, at - T0, {
      durationMs: spec.durationMs,
      model: spec.model,
      ...(spec.ended === "503" || spec.ended === "502"
        ? { ...failed503, status: Number(spec.ended) }
        : spec.ended === "left"
          ? { status: 499, streamEnd: Option.none() }
          : spec.ended === "fellBack"
            ? { requestedModel: Option.some("gpt-5") }
            : {}),
      ...(spec.agent === "root"
        ? {}
        : {
            conversationId: Option.some(spec.agent),
            parentConversationId: Option.some("root"),
            agentType: Option.some(spec.agent),
          }),
    });
  });

  const attempts = turns.flatMap((spec, index) =>
    spec.ended === "retried"
      ? [
          attempt({ requestId: `t${index}`, startedAt: T0, outcome: "failed" }),
          attempt({ requestId: `t${index}`, seq: 1, startedAt: T0 }),
        ]
      : [],
  );

  const now = at + 5_000;

  const timeline = timelineOf("root", requests, {
    attempts,
    live: live
      ? [liveTurn({ requestId: "live", at: at + 1, conversationId: Option.some("root") })]
      : [],
    now,
  });

  return { timeline, items: storyOf(timeline.items, now) };
};

const values = Arbitrary.schema(Conversation);

/** The model the client asked for: the one via fell back from, if it did. */
const asked = (row: TimelineTurn) =>
  row.live ? row.turn.model : Option.getOrElse(row.turn.requestedModel, () => row.turn.model);

/** A kept turn's status; none for one in flight. */
const statusOf = (row: TimelineTurn | undefined) =>
  row === undefined || row.live ? undefined : row.turn.status;

const succeeded = (row: TimelineTurn) =>
  !row.live && row.turn.status < 400 && Option.isNone(row.turn.requestedModel);

/** Whether an item is a marker: an idle stretch or a switch. */
const marker = (item: StoryItem | undefined) => item?.kind === "idle" || item?.kind === "switch";

describe("storyOf, for any conversation", () => {
  it("tells every turn exactly once, in the timeline's order", () => {
    holds(values, (conversation) => {
      const { timeline, items } = generated(conversation);
      const ids = told(items).map((row) => row.turn.requestId);

      return (
        ids.join() ===
          flatten(timeline.items)
            .map((row) => row.turn.requestId)
            .join() && new Set(ids).size === ids.length
      );
    });
  });

  it(`folds only runs of ${FOLD_MIN} or more turns that went fine, on one model`, () => {
    holds(values, (conversation) =>
      lists(generated(conversation).items).every((list) =>
        list.every(
          (item) =>
            item.kind !== "run" ||
            (item.turns.length >= FOLD_MIN &&
              item.turns.every(
                (row) =>
                  succeeded(row) &&
                  row.attempts.length <= 1 &&
                  row.turn.model === item.turns[0]?.turn.model,
              )),
        ),
      ),
    );
  });

  it("merges only two or more failures, of one model", () => {
    holds(values, (conversation) =>
      lists(generated(conversation).items).every((list) =>
        list.every(
          (item) =>
            item.kind !== "failures" ||
            (item.turns.length >= 2 &&
              item.turns.every(
                (row) =>
                  !row.live &&
                  row.turn.status >= 400 &&
                  row.turn.status !== 499 &&
                  row.turn.model === item.turns[0]?.turn.model &&
                  row.turn.status === statusOf(item.turns[0]),
              )),
        ),
      ),
    );
  });

  it("puts markers only between items: an idle stretch before a switch, never after it", () => {
    holds(values, (conversation) =>
      lists(generated(conversation).items).every(
        (list) =>
          !marker(list[0]) &&
          !marker(list.at(-1)) &&
          list.every((item, index) => {
            const next = list[index + 1];

            return item.kind === "idle"
              ? item.ms > IDLE_MS && next?.kind !== "idle"
              : item.kind !== "switch" || !marker(next);
          }),
      ),
    );
  });

  it("follows a model switch with a turn on that model", () => {
    holds(values, (conversation) =>
      lists(generated(conversation).items).every((list) =>
        list.every((item, index) => {
          if (item.kind !== "switch") return true;

          const [next] = told(list.slice(index + 1, index + 2));

          return item.from !== item.to && next !== undefined && asked(next) === item.to;
        }),
      ),
    );
  });
});
