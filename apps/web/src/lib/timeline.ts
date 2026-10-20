/**
 * A conversation laid out on one time axis, for its waterfall: each turn as
 * the share of the span from its start to its end, and each sub-agent's turns
 * nested under the conversation that started it, where its first turn came.
 */
import { Option } from "effect";
import type { UsageRequest } from "../api/types.ts";

/** A turn's row: its request, its number in the order turns came, and where its bar lies. */
export interface TimelineTurn {
  readonly kind: "turn";
  readonly turn: UsageRequest;
  readonly number: number;
  /** Where the turn started and ended, and its first chunk came, as shares of the span (0–1). */
  readonly start: number;
  readonly end: number;
  readonly firstChunk: Option.Option<number>;
}

/** A sub-agent's conversation: its id, its type when its client said, and its rows. */
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

/** Where an item starts, to order it among its siblings. */
const startOf = (item: TimelineItem): number =>
  item.kind === "turn" ? item.start : Math.min(...item.items.map(startOf));

/** The conversation `rootId`'s turns, its sub-agents' among them, oldest first, on one axis. */
export const timelineOf = (rootId: string, turns: ReadonlyArray<UsageRequest>): Timeline => {
  const ordered = turns.toSorted((a, b) => a.at - b.at);
  const from = Math.min(...ordered.map((turn) => turn.at));
  const end = Math.max(...ordered.map((turn) => turn.at + turn.durationMs));
  // A conversation of one instant still needs a span to draw its turn in.
  const to = Math.max(end, from + 1);
  const share = (at: number) => (at - from) / (to - from);

  // Each conversation's turns, and the conversation each was started by.
  const own = new Map<string, Array<TimelineTurn>>();
  const parents = new Map<string, string>();

  ordered.forEach((turn, index) => {
    const id = Option.getOrElse(turn.conversationId, () => rootId);

    const row: TimelineTurn = {
      kind: "turn",
      turn,
      number: index + 1,
      start: share(turn.at),
      end: share(turn.at + turn.durationMs),
      firstChunk: Option.map(turn.firstChunkMs, (ms) => share(turn.at + ms)),
    };

    own.set(id, [...(own.get(id) ?? []), row]);

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

    for (let at: string | undefined = parent; at !== undefined && own.has(at); at = parents.get(at)) {
      if (seen.has(at)) return rootId;

      seen.add(at);
    }

    return parent;
  };

  const itemsOf = (id: string): ReadonlyArray<TimelineItem> => {
    const children = [...own.keys()].filter((child) => child !== rootId && parentOf(child) === id);

    const agents = children.map(
      (child): TimelineAgent => ({
        kind: "agent",
        id: child,
        agentType: Option.firstSomeOf((own.get(child) ?? []).map((row) => row.turn.agentType)),
        items: itemsOf(child),
      }),
    );

    // A turn before a sub-agent that started at the same moment: it started the sub-agent.
    return [...(own.get(id) ?? []), ...agents].toSorted(
      (a, b) =>
        startOf(a) - startOf(b) || (a.kind === b.kind ? 0 : a.kind === "turn" ? -1 : 1),
    );
  };

  return { from, to, items: itemsOf(rootId) };
};
