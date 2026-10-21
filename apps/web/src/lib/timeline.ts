/**
 * A conversation laid out on one time axis, for its waterfall: each turn as
 * the share of the span from its start to its end, its upstream attempts
 * likewise, and each sub-agent's turns nested under the conversation that
 * started it, where its first turn came. A turn still in flight runs to now,
 * as does the axis while one is.
 */
import { Option } from "effect";
import type {
  LiveAttempt,
  LiveTurn,
  OpenAttempt,
  TurnAttempt,
  UsageRequest,
} from "../api/types.ts";

/** Where a bar lies, as shares of the span (0–1), and where its first chunk came. */
interface Place {
  readonly start: number;
  readonly end: number;
  readonly firstChunk: Option.Option<number>;
}

/** An upstream attempt's bar: one that ended, as kept, or one still under way. */
export type TimelineAttempt = Place &
  (
    | { readonly open: false; readonly attempt: TurnAttempt }
    | { readonly open: true; readonly attempt: OpenAttempt }
  );

/**
 * A turn's row: its request, as the history keeps it, or, `live`, as it stands
 * while in flight; its number in the order turns came; where its bar lies; and
 * its upstream attempts, none for a turn kept before via kept them.
 */
export type TimelineTurn = Place & {
  readonly kind: "turn";
  readonly number: number;
  readonly attempts: ReadonlyArray<TimelineAttempt>;
} & (
    | { readonly live: false; readonly turn: UsageRequest }
    | { readonly live: true; readonly turn: LiveTurn }
  );

/** A sub-agent's conversation: its id, its type when its client named one, and its rows. */
export interface TimelineAgent {
  readonly kind: "agent";
  readonly id: string;
  readonly agentType: Option.Option<string>;
  readonly items: ReadonlyArray<TimelineItem>;
}

export type TimelineItem = TimelineTurn | TimelineAgent;

/** The span the turns take, in epoch milliseconds, and their rows. */
export interface Timeline {
  readonly from: number;
  readonly to: number;
  readonly items: ReadonlyArray<TimelineItem>;
}

/** What else goes on the axis: the turns' attempts, the turns in flight, and the time now. */
interface Extra {
  readonly attempts?: ReadonlyArray<TurnAttempt>;
  readonly live?: ReadonlyArray<LiveTurn>;
  readonly now?: number;
}

/** A turn, kept or in flight, as the layout reads it. */
type Entry =
  | { readonly live: false; readonly turn: UsageRequest }
  | { readonly live: true; readonly turn: LiveTurn };

/** Where an item starts, to order it among its siblings. */
const startOf = (item: TimelineItem): number =>
  item.kind === "turn" ? item.start : Math.min(...item.items.map(startOf));

const isOpen = (attempt: LiveAttempt): attempt is OpenAttempt => attempt.state === "open";

/**
 * The conversation `rootId`'s turns, its sub-agents' among them, oldest first,
 * on one axis, with their `attempts`, and the turns in flight that belong to it
 * running to `now`.
 */
export const timelineOf = (
  rootId: string,
  turns: ReadonlyArray<UsageRequest>,
  { attempts = [], live = [], now = 0 }: Extra = {},
): Timeline => {
  const entries: ReadonlyArray<Entry> = [
    ...turns.map((turn) => ({ live: false as const, turn })),
    ...live.map((turn) => ({ live: true as const, turn })),
  ].toSorted((a, b) => a.turn.at - b.turn.at);

  const from = Math.min(...entries.map(({ turn }) => turn.at));

  const end = Math.max(
    ...entries.map((entry) => (entry.live ? now : entry.turn.at + entry.turn.durationMs)),
  );

  // A conversation of one instant still needs a span to draw its turn in.
  const to = Math.max(end, from + 1);
  const share = (at: number) => (at - from) / (to - from);

  const kept = Map.groupBy(attempts, ({ requestId }) => requestId);

  const placeKept = (attempt: TurnAttempt): TimelineAttempt => ({
    open: false,
    attempt,
    start: share(attempt.startedAt),
    end: share(attempt.startedAt + attempt.durationMs),
    firstChunk: Option.map(attempt.firstChunkMs, (ms) => share(attempt.startedAt + ms)),
  });

  const placeLive = (attempt: LiveAttempt): TimelineAttempt =>
    isOpen(attempt)
      ? {
          open: true,
          attempt,
          start: share(attempt.startedAt),
          end: 1,
          firstChunk: Option.map(attempt.firstChunkMs, (ms) => share(attempt.startedAt + ms)),
        }
      : placeKept(attempt);

  const rowOf = (entry: Entry, number: number): TimelineTurn => {
    if (!entry.live) {
      const { turn } = entry;

      return {
        kind: "turn",
        live: false,
        turn,
        number,
        start: share(turn.at),
        end: share(turn.at + turn.durationMs),
        firstChunk: Option.map(turn.firstChunkMs, (ms) => share(turn.at + ms)),
        attempts: (kept.get(turn.requestId) ?? []).toSorted((a, b) => a.seq - b.seq).map(placeKept),
      };
    }

    const placed = entry.turn.attempts.map(placeLive);

    return {
      kind: "turn",
      live: true,
      turn: entry.turn,
      number,
      start: share(entry.turn.at),
      end: 1,
      // The first chunk the turn had: the one the attempt still under way sent.
      firstChunk: Option.firstSomeOf(placed.toReversed().map(({ firstChunk }) => firstChunk)),
      attempts: placed,
    };
  };

  // Each conversation's turns, and the conversation each was started by.
  const own = new Map<string, Array<TimelineTurn>>();
  const parents = new Map<string, string>();

  entries.forEach((entry, index) => {
    const { turn } = entry;
    const id = Option.getOrElse(turn.conversationId, () => rootId);

    own.set(id, [...(own.get(id) ?? []), rowOf(entry, index + 1)]);

    if (Option.isSome(turn.parentConversationId) && !parents.has(id)) {
      parents.set(id, turn.parentConversationId.value);
    }
  });

  // A sub-agent whose parent left no turns here, or whose parents lead round in a
  // circle, sits under the conversation itself.
  const parentOf = (id: string) => {
    const parent = parents.get(id);

    if (parent === undefined || !own.has(parent)) return rootId;

    const seen = new Set([id]);

    for (
      let at: string | undefined = parent;
      at !== undefined && own.has(at);
      at = parents.get(at)
    ) {
      if (seen.has(at)) return rootId;

      seen.add(at);
    }

    return parent;
  };

  const itemsOf = (id: string): ReadonlyArray<TimelineItem> => {
    const children = [...own.keys()].filter((child) => child !== rootId && parentOf(child) === id);

    const agents = children.map((child): TimelineAgent => ({
      kind: "agent",
      id: child,
      // A blank type says no more than none.
      agentType: Option.firstSomeOf(
        (own.get(child) ?? []).map((row) =>
          Option.filter(row.turn.agentType, (type) => type.trim() !== ""),
        ),
      ),
      items: itemsOf(child),
    }));

    // A turn before a sub-agent that started at the same moment: it started the sub-agent.
    return [...(own.get(id) ?? []), ...agents].toSorted(
      (a, b) => startOf(a) - startOf(b) || (a.kind === b.kind ? 0 : a.kind === "turn" ? -1 : 1),
    );
  };

  return { from, to, items: itemsOf(rootId) };
};
