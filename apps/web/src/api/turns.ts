/**
 * The turns via is handling now, as `/admin/events` sends them: each from its
 * `turn.started` to its `turn.ended`, with its upstream attempts as they stand.
 * They live in the query cache, under {@link liveTurnsKey}, in the order they
 * started; no query fetches them, as via pushes every change.
 *
 * A turn that ended is held a little longer, under {@link endedTurnsKey}, as
 * via sent it, until a fetch of the history has it: a page shows it in their
 * place until then, so it never blinks out between.
 */
import { type QueryClient, skipToken, useQuery } from "@tanstack/react-query";
import { TurnEvent } from "@via/server/admin-api";
import { Option, Predicate, Schema } from "effect";
import { ancestry } from "../lib/live-conversations.ts";
import type { EndedTurn, LiveTurn } from "./types.ts";

export const liveTurnsKey = ["live-turns"] as const;

export const endedTurnsKey = ["ended-turns"] as const;

/** At most this many ended turns are held, should the history never be fetched again. */
const ENDED_HELD = 100;

const decodeTurnEvent = Schema.decodeUnknownOption(TurnEvent);

/** The SSE event `event`, with `data`, as a turn event; none when it isn't one. */
export const parseTurnEvent = (event: string, data: string) => decodeTurnEvent({ event, data });

/** `turns` as `event` leaves them. */
const applied = (turns: ReadonlyArray<LiveTurn>, event: TurnEvent): ReadonlyArray<LiveTurn> => {
  switch (event.event) {
    case "turn.started":
      return [...turns.filter(({ requestId }) => requestId !== event.data.requestId), event.data];
    case "turn.attempt": {
      const attempt = event.data;

      return turns.map((turn) =>
        turn.requestId === attempt.requestId
          ? {
              ...turn,
              attempts: [
                ...turn.attempts.filter(({ seq }) => seq !== attempt.seq),
                attempt,
              ].toSorted((a, b) => a.seq - b.seq),
            }
          : turn,
      );
    }

    case "turn.ended":
      return turns.filter(({ requestId }) => requestId !== event.data.entry.requestId);
  }
};

/** The history's queries that list turns, or the conversations they belong to. */
const LISTING = new Set(["conversation", "requests", "conversations"]);

/** What a page of the history says of the turns: those it has, and the conversations it lists. */
const Listing = Schema.Struct({
  turns: Schema.optional(Schema.Array(Schema.Struct({ requestId: Schema.String }))),
  requests: Schema.optional(Schema.Array(Schema.Struct({ requestId: Schema.String }))),
  conversations: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});

/** A list's pages, as an infinite query holds them. */
const Paged = Schema.Struct({ pages: Schema.Array(Listing) });

/** A fetch of the history: a list's pages, or one page. */
const decodeFetched = Schema.decodeUnknownOption(Schema.Union([Paged, Listing]));

const isPaged = Schema.is(Paged);

/**
 * What a fetch of the history, `fetched`, says of the turns: those it has, by
 * request id, are held once ended no more; nor are the ended turns of a
 * conversation it lists, as the list then has them.
 */
const settle = (queryClient: QueryClient, fetched: typeof Listing.Type | typeof Paged.Type) => {
  const pages = isPaged(fetched) ? fetched.pages : [fetched];

  const kept = new Set(
    pages.flatMap(({ turns = [], requests = [] }) =>
      [...turns, ...requests].map(({ requestId }) => requestId),
    ),
  );

  const listed = new Set(
    pages.flatMap(({ conversations = [] }) => conversations.map(({ id }) => id)),
  );

  const live = queryClient.getQueryData<ReadonlyArray<LiveTurn>>(liveTurnsKey) ?? [];
  const ended = queryClient.getQueryData<ReadonlyArray<EndedTurn>>(endedTurnsKey) ?? [];
  const chains = ancestry([...ended.map(({ entry }) => entry), ...live]);

  const had = ({ requestId }: { readonly requestId: string }) =>
    kept.has(requestId) || (chains.get(requestId) ?? []).some((id) => listed.has(id));

  if (ended.some(({ entry }) => had(entry))) {
    queryClient.setQueryData<ReadonlyArray<EndedTurn>>(
      endedTurnsKey,
      ended.filter(({ entry }) => !had(entry)),
    );
  }
};

/**
 * Keeps the turns however long no page shows them, as a query no component
 * watches is otherwise dropped after five minutes, a turn in flight with it;
 * and lets go of them as each fetch of the history has them, for as long as
 * `queryClient` lives.
 */
export function holdTurns(queryClient: QueryClient) {
  queryClient.setQueryDefaults(liveTurnsKey, { gcTime: Infinity });
  queryClient.setQueryDefaults(endedTurnsKey, { gcTime: Infinity });

  queryClient.getQueryCache().subscribe((event) => {
    const [root, kind] = event.query.queryKey;

    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      root === "history" &&
      Predicate.isString(kind) &&
      LISTING.has(kind)
    ) {
      Option.map(decodeFetched(event.action.data), (fetched) => settle(queryClient, fetched));
    }
  });
}

/** Puts in the cache what `event` says of the turns in flight. */
export function applyTurnEvent(queryClient: QueryClient, event: TurnEvent) {
  queryClient.setQueryData<ReadonlyArray<LiveTurn>>(liveTurnsKey, (turns = []) =>
    applied(turns, event),
  );

  if (event.event === "turn.ended") {
    const id = event.data.entry.requestId;

    queryClient.setQueryData<ReadonlyArray<EndedTurn>>(endedTurnsKey, (ended = []) =>
      [...ended.filter(({ entry }) => entry.requestId !== id), event.data].slice(-ENDED_HELD),
    );
  }
}

const none: ReadonlyArray<never> = [];

/** The turns in flight, oldest first; the caller renders again as they change. */
export const useLiveTurns = (): ReadonlyArray<LiveTurn> =>
  useQuery<ReadonlyArray<LiveTurn>>({ queryKey: liveTurnsKey, queryFn: skipToken }).data ?? none;

/** The turns that ended which the history may not have yet; the caller renders again as they change. */
export const useEndedTurns = (): ReadonlyArray<EndedTurn> =>
  useQuery<ReadonlyArray<EndedTurn>>({ queryKey: endedTurnsKey, queryFn: skipToken }).data ?? none;

/**
 * Forgets every turn in flight: once the stream drops, a turn may end unseen.
 * When it is back, via sends a `turn.started` for each turn still in flight.
 * Those that ended are held still, until the history has them.
 */
export function forgetLive(queryClient: QueryClient) {
  queryClient.setQueryData<ReadonlyArray<LiveTurn>>(liveTurnsKey, []);
}
