/**
 * A conversation told as a story, down a time spine: the turns that went
 * fine one after another on one model folded into one line, failures in a row
 * that failed the same way merged into one, a marker where nothing ran for a
 * while and one where the client switched model, and each sub-agent's turns as
 * a thread of their own. Every turn is told exactly once, in the timeline's order.
 */
import { Option } from "effect";
import type { TurnAttempt } from "../api/types.ts";
import { attemptOutcomeNames, categoryNames, didNotServe } from "./attempt.ts";
import { failed, outcomeKind, outcomeOf } from "./request-outcome.ts";
import type { Timeline, TimelineAgent, TimelineItem, TimelineTurn } from "./timeline.ts";

/** A stretch longer than this with nothing running gets a marker of its own. */
export const IDLE_MS = 3_000;

/** The fewest turns that fold into one line: two read as well on their own. */
export const FOLD_MIN = 3;

/** A turn, more than one in a row, or a sub-agent's thread: what a story tells, with its markers. */
export type StoryItem =
  | { readonly kind: "idle"; readonly key: string; readonly ms: number }
  /** Where a new day starts on the viewer's clock, at the first time on it. */
  | { readonly kind: "day"; readonly key: string; readonly at: number }
  | { readonly kind: "switch"; readonly key: string; readonly from: string; readonly to: string }
  /** A turn: on a card when it has something to say, else on a line. */
  | {
      readonly kind: "turn";
      readonly key: string;
      readonly turn: TimelineTurn;
      readonly card: boolean;
    }
  /** Turns in a row that went fine, on one model. */
  | { readonly kind: "run"; readonly key: string; readonly turns: ReadonlyArray<TimelineTurn> }
  /** Turns in a row that failed the same way. */
  | {
      readonly kind: "failures";
      readonly key: string;
      readonly turns: ReadonlyArray<TimelineTurn>;
    }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly agent: TimelineAgent;
      /** When its first turn came in and its last ended, in epoch milliseconds. */
      readonly from: number;
      readonly to: number;
      readonly turns: number;
      readonly items: ReadonlyArray<StoryItem>;
    };

/**
 * What turns, by `numbers` in the order they came, are called: "Turns 3–5"
 * when one came after another, else each run of them, "Turns 2, 4–6, 9", as
 * a sub-agent's turns may have others between them.
 */
export const turnsLabel = (numbers: ReadonlyArray<number>) => {
  const runs: Array<[number, number]> = [];

  for (const number of numbers) {
    const last = runs.at(-1);

    if (last !== undefined && number === last[1] + 1) last[1] = number;
    else runs.push([number, number]);
  }

  return `Turns ${runs.map(([first, last]) => (first === last ? `${first}` : `${first}–${last}`)).join(", ")}`;
};

/** The turns of `items`, down into each sub-agent's. */
const turnsOf = (items: ReadonlyArray<TimelineItem>): ReadonlyArray<TimelineTurn> =>
  items.flatMap((item) => (item.kind === "turn" ? [item] : turnsOf(item.items)));

/** How long a turn took, or, in flight, has taken until `now`. */
export const tookMs = (row: TimelineTurn, now: number) =>
  row.live ? Math.max(now - row.turn.at, 0) : row.turn.durationMs;

/**
 * How long a turn waited for its first token: as kept, or, in flight, as the
 * attempt under way says; none when it had none.
 */
export const waitedMs = (row: TimelineTurn): Option.Option<number> =>
  row.live
    ? Option.firstSomeOf(
        row.turn.attempts
          .toReversed()
          .map((attempt) =>
            attempt.state === "open"
              ? Option.map(attempt.firstChunkMs, (ms) => attempt.startedAt + ms - row.turn.at)
              : Option.none(),
          ),
      )
    : row.turn.firstChunkMs;

/** The model a turn's client asked for: the one via fell back from, when it did. */
const askedModel = (row: TimelineTurn) =>
  row.live ? row.turn.model : Option.getOrElse(row.turn.requestedModel, () => row.turn.model);

/** Whether a turn ended failed: an error, or a stream that broke off. */
const turnFailed = (row: TimelineTurn) => !row.live && failed(row.turn);

/** Attempts of a turn that ended and didn't serve. */
export const unserved = (row: TimelineTurn): ReadonlyArray<TurnAttempt> =>
  row.attempts.flatMap((placed) =>
    !placed.open && didNotServe(placed.attempt) ? [placed.attempt] : [],
  );

/** Why a turn failed: its status, the reason in a word or two, the upstream's code and message. */
export interface Failure {
  readonly status: Option.Option<number>;
  readonly reason: string;
  readonly code: Option.Option<string>;
  readonly message: Option.Option<string>;
}

/** A failed turn's failure: what its first attempt that didn't serve said, else what via answered. */
export const failureOf = (row: TimelineTurn): Option.Option<Failure> => {
  if (row.live || !failed(row.turn)) return Option.none();

  const [first] = unserved(row);

  return Option.some(
    first === undefined
      ? {
          status: Option.some(row.turn.status),
          reason: outcomeOf(row.turn),
          code: row.turn.error,
          message: row.turn.errorMessage,
        }
      : {
          status: first.status,
          reason: Option.match(first.category, {
            onNone: () => attemptOutcomeNames[first.outcome],
            onSome: (category) => categoryNames[category],
          }),
          code: first.upstreamCode,
          message: first.message,
        },
  );
};

/** What makes two failures the same: the model, and the status, reason and code. */
const sameness = (row: TimelineTurn) =>
  Option.map(failureOf(row), (failure) =>
    JSON.stringify([
      askedModel(row),
      Option.getOrNull(failure.status),
      failure.reason,
      Option.getOrNull(failure.code),
    ]),
  );

/** Whether a turn has nothing to say beyond that it went fine: no failure, fallback, retry or flight. */
const routine = (row: TimelineTurn) =>
  !row.live &&
  outcomeKind(row.turn) === "ok" &&
  row.attempts.length <= 1 &&
  unserved(row).length === 0;

const startOf = (item: TimelineItem) => Math.min(...turnsOf([item]).map((row) => row.turn.at));

const lastStartOf = (item: TimelineItem) => Math.max(...turnsOf([item]).map((row) => row.turn.at));

/** The day a time falls on, on the viewer's clock. */
const dayOf = (at: number) => new Date(at).toDateString();

const endOf = (item: TimelineItem, now: number) =>
  Math.max(...turnsOf([item]).map((row) => row.turn.at + tookMs(row, now)));

/** The items of a list of the timeline, told as a story, with turns in flight running to `now`. */
export const storyOf = (
  items: ReadonlyArray<TimelineItem>,
  now: number,
): ReadonlyArray<StoryItem> => {
  const told: Array<StoryItem> = [];
  let run: Array<TimelineTurn> = [];
  let reach = -Infinity;
  let model: string | undefined;
  let day: string | undefined;

  const flush = () => {
    const [first] = run;

    if (first !== undefined && run.length >= FOLD_MIN) {
      told.push({ kind: "run", key: `run-${first.turn.requestId}`, turns: run });
    } else {
      told.push(
        ...run.map((row): StoryItem => ({
          kind: "turn",
          key: row.turn.requestId,
          turn: row,
          card: false,
        })),
      );
    }

    run = [];
  };

  for (const item of items) {
    const start = startOf(item);
    const key = item.kind === "turn" ? item.turn.requestId : `agent-${item.id}`;

    if (Number.isFinite(reach) && start - reach > IDLE_MS) {
      flush();
      told.push({ kind: "idle", key: `idle-${key}`, ms: start - reach });
    }

    reach = Math.max(reach, endOf(item, now));

    if (day !== undefined && day !== dayOf(start)) {
      flush();
      told.push({ kind: "day", key: `day-${key}`, at: start });
    }

    // A sub-agent's thread marks the days it runs into; after it, the day is its last.
    day = dayOf(lastStartOf(item));

    if (item.kind === "agent") {
      flush();

      told.push({
        kind: "agent",
        key,
        agent: item,
        from: start,
        to: endOf(item, now),
        turns: turnsOf(item.items).length,
        items: storyOf(item.items, now),
      });

      continue;
    }

    const asked = askedModel(item);

    if (model !== undefined && model !== asked) {
      flush();
      told.push({ kind: "switch", key: `switch-${key}`, from: model, to: asked });
    }

    model = asked;

    if (routine(item)) {
      if (run[0] !== undefined && askedModel(run[0]) !== asked) flush();
      run.push(item);
      continue;
    }

    flush();
    const last = told.at(-1);
    const same = Option.getOrUndefined(sameness(item));

    const before =
      last?.kind === "failures"
        ? last.turns
        : last?.kind === "turn" && last.card
          ? [last.turn]
          : [];

    const previous = before.at(-1);

    if (
      same !== undefined &&
      previous !== undefined &&
      same === Option.getOrUndefined(sameness(previous))
    ) {
      told[told.length - 1] = {
        kind: "failures",
        key: `failures-${before[0]?.turn.requestId ?? key}`,
        turns: [...before, item],
      };
    } else {
      told.push({ kind: "turn", key, turn: item, card: true });
    }
  }

  flush();

  return told;
};

/** What a story's headline says: how many turns, over how long, and how they went. */
export interface StorySummary {
  readonly turns: number;
  /** From the first turn's start to the last's end, or to now. */
  readonly spanMs: number;
  /** The turns' time, added up: the model's time. */
  readonly busyMs: number;
  readonly models: number;
  readonly failed: number;
  readonly live: number;
  /** Turns in flight that have had their first token. */
  readonly streaming: number;
}

export const storySummary = (timeline: Timeline, now: number): StorySummary => {
  const rows = turnsOf(timeline.items);
  const live = rows.filter((row) => row.live);

  return {
    turns: rows.length,
    spanMs: rows.length === 0 ? 0 : timeline.to - timeline.from,
    busyMs: rows.reduce((sum, row) => sum + tookMs(row, now), 0),
    models: new Set(rows.map((row) => row.turn.model)).size,
    failed: rows.filter(turnFailed).length,
    live: live.length,
    streaming: live.filter((row) => Option.isSome(waitedMs(row))).length,
  };
};

const pad = (value: number) => String(value).padStart(2, "0");

/** A time from the conversation's start, as a clock reads it: 0:09, 1:26, 1:02:03. */
export const clockOffset = (ms: number) => {
  const seconds = Math.max(Math.floor(ms / 1_000), 0);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}`
    : `${minutes}:${pad(seconds % 60)}`;
};
