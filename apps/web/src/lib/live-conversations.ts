/**
 * Which conversation a turn in flight, or one that just ended, belongs to:
 * the one it names, or, for a sub-agent's, the one its parents lead up to.
 */
import { Option } from "effect";
import type {
  ConversationSummary,
  EndedTurn,
  LiveTurn,
  TurnAttempt,
  UsageRequest,
} from "../api/types.ts";
import { failed } from "./request-outcome.ts";

/** What says which conversation a turn belongs to. */
interface Member {
  readonly requestId: string;
  readonly conversationId: Option.Option<string>;
  readonly parentConversationId: Option.Option<string>;
}

/**
 * Of `others`, the turns of the conversation `rootId`, whose turns are `turns`:
 * its own, its sub-agents' and theirs, at any depth, as their parents say.
 */
export const joining = <T extends Member>(
  rootId: string,
  turns: ReadonlyArray<Member>,
  others: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const ids = new Set([
    rootId,
    ...turns.flatMap(({ conversationId }) => Option.toArray(conversationId)),
  ]);

  const taken = new Set<T>();

  // A sub-agent's turn may come before its parent's: go round until none joins.
  for (let grew = true; grew;) {
    grew = false;

    for (const turn of others) {
      if (taken.has(turn) || Option.isNone(turn.conversationId)) continue;

      const joins =
        ids.has(turn.conversationId.value) ||
        Option.exists(turn.parentConversationId, (parent) => ids.has(parent));

      if (joins) {
        taken.add(turn);
        ids.add(turn.conversationId.value);
        grew = true;
      }
    }
  }

  return others.filter((turn) => taken.has(turn));
};

/** A conversation's turns and their attempts, and its turns in flight. */
export interface Standing {
  readonly turns: ReadonlyArray<UsageRequest>;
  readonly attempts: ReadonlyArray<TurnAttempt>;
  readonly live: ReadonlyArray<LiveTurn>;
}

/**
 * The conversation `id` as it stands now: the turns the history has of it,
 * `kept`, then those of `ended` it doesn't have yet, and of `live` those in
 * flight, each once, whichever conversation of it they belong to.
 */
export const standing = (
  id: string,
  kept: Pick<Standing, "turns" | "attempts">,
  ended: ReadonlyArray<EndedTurn>,
  live: ReadonlyArray<LiveTurn>,
): Standing => {
  const keptIds = new Set(kept.turns.map(({ requestId }) => requestId));

  const since = joining(
    id,
    kept.turns,
    ended.flatMap(({ entry }) => (keptIds.has(entry.requestId) ? [] : [entry])),
  );

  const sinceIds = new Set(since.map(({ requestId }) => requestId));

  return {
    turns: [...kept.turns, ...since],
    attempts: [
      ...kept.attempts,
      ...ended
        .filter(({ entry }) => sinceIds.has(entry.requestId))
        .flatMap(({ attempts }) => attempts),
    ],
    live: joining(
      id,
      [...kept.turns, ...since],
      live.filter(({ requestId }) => !keptIds.has(requestId) && !sinceIds.has(requestId)),
    ),
  };
};

/**
 * A conversation the history has no summary of yet, as its turns that ended
 * since and those in flight make it: its harness and key as its latest turn
 * had them, its models, when it started and was last active, its turns and
 * sub-agents, and the tokens of those that ended. It has cost nothing known yet.
 */
export const pendingSummary = (
  id: string,
  ended: ReadonlyArray<UsageRequest>,
  live: ReadonlyArray<LiveTurn>,
): ConversationSummary => {
  const turns = [...ended, ...live].toSorted((a, b) => a.at - b.at);
  const latest = turns.toReversed();

  const sum = (field: (turn: UsageRequest) => Option.Option<number>) =>
    ended.reduce((total, turn) => total + Option.getOrElse(field(turn), () => 0), 0);

  return {
    id,
    source: "",
    guessed: false,
    client: Option.firstSomeOf(latest.map(({ client }) => client)),
    keyName: Option.firstSomeOf(latest.map(({ keyName }) => keyName)),
    models: [...new Set(turns.map(({ model }) => model))],
    firstAt: Math.min(...turns.map(({ at }) => at)),
    lastAt: Math.max(...turns.map(({ at }) => at)),
    turns: turns.length,
    subagents: new Set(
      turns.flatMap(({ conversationId }) => Option.toArray(conversationId)).filter((c) => c !== id),
    ).size,
    inputTokens: sum(({ inputTokens }) => inputTokens),
    cachedTokens: sum(({ cachedTokens }) => cachedTokens),
    outputTokens: sum(({ outputTokens }) => outputTokens),
    reasoningTokens: sum(({ reasoningTokens }) => reasoningTokens),
    failed: ended.filter(failed).length,
    fellBack: ended.filter(({ requestedModel }) => Option.isSome(requestedModel)).length,
    cost: { apiEquivalentUsd: 0, billedUsd: 0, unpriced: [] },
  };
};

/** The conversations a list shows live, and those it doesn't list yet, from the turns in flight. */
interface Unlisted {
  /** Every conversation a turn in flight belongs to, its parents' included. */
  readonly live: ReadonlySet<string>;
  /** The conversations none of whose turns, nor parents, the list has, the latest active first. */
  readonly pending: ReadonlyArray<ConversationSummary>;
}

/**
 * Of the turns in flight, `live`, and those that ended since, `ended`: which
 * conversations they keep live, and which they started that `listed` hasn't.
 */
export const unlisted = (
  listed: ReadonlySet<string>,
  ended: ReadonlyArray<EndedTurn>,
  live: ReadonlyArray<LiveTurn>,
): Unlisted => {
  const entries = ended.map(({ entry }) => entry);
  const chains = ancestry([...entries, ...live]);
  const chainOf = (requestId: string) => chains.get(requestId) ?? [];

  // The conversation a turn started that the list hasn't, if it did.
  const unlistedRoot = ({ requestId }: { readonly requestId: string }) => {
    const chain = chainOf(requestId);

    return chain.some((id) => listed.has(id)) ? undefined : chain.at(-1);
  };

  const endedBy = Map.groupBy(entries, unlistedRoot);
  const liveBy = Map.groupBy(live, unlistedRoot);

  return {
    live: new Set(live.flatMap(({ requestId }) => chainOf(requestId))),
    pending: [...new Set([...endedBy.keys(), ...liveBy.keys()])]
      .flatMap((root) =>
        root === undefined
          ? []
          : [pendingSummary(root, endedBy.get(root) ?? [], liveBy.get(root) ?? [])],
      )
      .toSorted((a, b) => b.lastAt - a.lastAt),
  };
};

/**
 * Each turn's conversation, by request id, then those its parents lead up
 * through, as `turns` say, the last the one it all started from as far as
 * they know. A turn of no conversation has none.
 */
export const ancestry = (
  turns: ReadonlyArray<Member>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const parents = new Map<string, string>();

  for (const { conversationId, parentConversationId } of turns) {
    if (Option.isSome(conversationId) && Option.isSome(parentConversationId)) {
      parents.set(conversationId.value, parentConversationId.value);
    }
  }

  const chainOf = (id: string) => {
    const chain = [id];

    for (let at = parents.get(id); at !== undefined && !chain.includes(at); at = parents.get(at)) {
      chain.push(at);
    }

    return chain;
  };

  return new Map(
    turns.flatMap(({ requestId, conversationId }) =>
      Option.match(conversationId, {
        onNone: () => [],
        onSome: (id) => [[requestId, chainOf(id)] as const],
      }),
    ),
  );
};
