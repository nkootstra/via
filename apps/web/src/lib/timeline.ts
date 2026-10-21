/**
 * A conversation's turns in the order they came, numbered, each with its
 * upstream attempts, and each sub-agent's turns nested under the conversation
 * that started it, where its first turn came; and the span they take, from the
 * first turn's start to the last's end, or to now while a turn is in flight.
 */
import { Option } from "effect";
import type {
  LiveAttempt,
  LiveTurn,
  OpenAttempt,
  TurnAttempt,
  UsageRequest,
} from "../api/types.ts";

/** An upstream attempt: one that ended, as kept, or one still under way. */
export type TimelineAttempt =
  | { readonly open: false; readonly attempt: TurnAttempt }
  | { readonly open: true; readonly attempt: OpenAttempt };

/**
 * A turn: its request, as the history keeps it, or, `live`, as it stands
 * while in flight; its number in the order turns came; and its upstream
 * attempts, none for a turn kept before via kept them.
 */
export type TimelineTurn = {
  readonly kind: "turn";
  readonly number: number;
  readonly attempts: ReadonlyArray<TimelineAttempt>;
} & (
  | { readonly live: false; readonly turn: UsageRequest }
  | { readonly live: true; readonly turn: LiveTurn }
);

/** A sub-agent's conversation: its id, its type when its client named one, and its items. */
export interface TimelineAgent {
  readonly kind: "agent";
  readonly id: string;
  readonly agentType: Option.Option<string>;
  readonly items: ReadonlyArray<TimelineItem>;
}

export type TimelineItem = TimelineTurn | TimelineAgent;

/** The span the turns take, in epoch milliseconds, and the turns. */
export interface Timeline {
  readonly from: number;
  readonly to: number;
  readonly items: ReadonlyArray<TimelineItem>;
}

/** What else the timeline holds: the turns' attempts, the turns in flight, and the time now. */
interface Extra {
  readonly attempts?: ReadonlyArray<TurnAttempt>;
  readonly live?: ReadonlyArray<LiveTurn>;
  readonly now?: number;
}

/** A turn, kept or in flight, as the layout reads it. */
type Entry =
  | { readonly live: false; readonly turn: UsageRequest }
  | { readonly live: true; readonly turn: LiveTurn };

/** `turns` in the order they came: by when each started, two at once as given. */
export const byStart = <T extends { readonly at: number }>(turns: ReadonlyArray<T>) =>
  turns.toSorted((a, b) => a.at - b.at);

/**
 * Each turn's number, by request id, in the order they came: the one number
 * the story, the turns list, a request's sheet and an export all give it.
 */
export const turnNumbers = (
  turns: ReadonlyArray<{ readonly requestId: string; readonly at: number }>,
): ReadonlyMap<string, number> =>
  new Map(byStart(turns).map(({ requestId }, index) => [requestId, index + 1]));

/** Where an item starts, to order it among its siblings. */
const startOf = (item: TimelineItem): number =>
  item.kind === "turn" ? item.turn.at : Math.min(...item.items.map(startOf));

const isOpen = (attempt: LiveAttempt): attempt is OpenAttempt => attempt.state === "open";

/**
 * The conversation `rootId`'s turns, its sub-agents' among them, oldest first,
 * with their `attempts`, and the turns in flight that belong to it running to `now`.
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

  const numbers = turnNumbers(entries.map(({ turn }) => turn));

  const from = Math.min(...entries.map(({ turn }) => turn.at));

  const end = Math.max(
    ...entries.map((entry) => (entry.live ? now : entry.turn.at + entry.turn.durationMs)),
  );

  const to = Math.max(end, from);
  const kept = Map.groupBy(attempts, ({ requestId }) => requestId);

  const rowOf = (entry: Entry, number: number): TimelineTurn =>
    entry.live
      ? {
          kind: "turn",
          live: true,
          turn: entry.turn,
          number,
          attempts: entry.turn.attempts.map((attempt) =>
            isOpen(attempt) ? { open: true as const, attempt } : { open: false as const, attempt },
          ),
        }
      : {
          kind: "turn",
          live: false,
          turn: entry.turn,
          number,
          attempts: (kept.get(entry.turn.requestId) ?? [])
            .toSorted((a, b) => a.seq - b.seq)
            .map((attempt) => ({ open: false as const, attempt })),
        };

  // Each conversation's turns, and the conversation each was started by.
  const own = new Map<string, Array<TimelineTurn>>();
  const parents = new Map<string, string>();

  for (const entry of entries) {
    const { turn } = entry;
    const id = Option.getOrElse(turn.conversationId, () => rootId);

    own.set(id, [...(own.get(id) ?? []), rowOf(entry, numbers.get(turn.requestId) ?? 0)]);

    if (Option.isSome(turn.parentConversationId) && !parents.has(id)) {
      parents.set(id, turn.parentConversationId.value);
    }
  }

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
