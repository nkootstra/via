/**
 * The turns via is handling now, as `/admin/events` sends them: each from its
 * `turn.started` to its `turn.ended`, with its upstream attempts as they stand.
 * They live in the query cache, under {@link liveTurnsKey}, in the order they
 * started; no query fetches them, as via pushes every change.
 *
 * A turn that ended is held a little longer, under {@link endedTurnsKey}, as
 * via sent it, until the history queries have fetched again and have it: a
 * page shows it in their place until then, so it never blinks out between.
 */
import { type QueryClient, skipToken, useQuery } from "@tanstack/react-query";
import { TurnEvent } from "@via/server/admin-api";
import { Schema } from "effect";
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

/**
 * Keeps the turns however long no page shows them: a query no component
 * watches is otherwise dropped after five minutes, a turn in flight with it.
 */
export function holdTurns(queryClient: QueryClient) {
  queryClient.setQueryDefaults(liveTurnsKey, { gcTime: Infinity });
  queryClient.setQueryDefaults(endedTurnsKey, { gcTime: Infinity });
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

/** The ended turns held now, by id: those a fetch of the history started after now has. */
export const heldEnded = (queryClient: QueryClient) =>
  new Set(
    (queryClient.getQueryData<ReadonlyArray<EndedTurn>>(endedTurnsKey) ?? []).map(
      ({ entry }) => entry.requestId,
    ),
  );

/** Lets go of the ended turns `ids`, once the history has them. */
export function releaseEnded(queryClient: QueryClient, ids: ReadonlySet<string>) {
  queryClient.setQueryData<ReadonlyArray<EndedTurn>>(endedTurnsKey, (ended = []) =>
    ended.filter(({ entry }) => !ids.has(entry.requestId)),
  );
}

const none: ReadonlyArray<never> = [];

/** The turns in flight, oldest first; the caller renders again as they change. */
export const useLiveTurns = (): ReadonlyArray<LiveTurn> =>
  useQuery<ReadonlyArray<LiveTurn>>({ queryKey: liveTurnsKey, queryFn: skipToken }).data ?? none;

/** The turns that ended which the history may not have yet; the caller renders again as they change. */
export const useEndedTurns = (): ReadonlyArray<EndedTurn> =>
  useQuery<ReadonlyArray<EndedTurn>>({ queryKey: endedTurnsKey, queryFn: skipToken }).data ?? none;

/**
 * Forgets every turn in flight, and those that ended: once the stream drops, a
 * turn may end unseen. When it is back, via sends a `turn.started` for each
 * turn still in flight.
 */
export function forgetTurns(queryClient: QueryClient) {
  queryClient.setQueryData<ReadonlyArray<LiveTurn>>(liveTurnsKey, []);
  queryClient.setQueryData<ReadonlyArray<EndedTurn>>(endedTurnsKey, []);
}
