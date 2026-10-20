/**
 * The turns via is handling now, as `/admin/events` sends them: each from its
 * `turn.started` to its `turn.ended`, with its upstream attempts as they stand.
 * They live in the query cache, under {@link liveTurnsKey}, in the order they
 * started; no query fetches them, as via pushes every change.
 */
import type { QueryClient } from "@tanstack/react-query";
import { TurnEvent } from "@via/server/admin-api";
import { Schema } from "effect";

type LiveTurn = Extract<TurnEvent, { event: "turn.started" }>["data"];

export const liveTurnsKey = ["live-turns"] as const;

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

/** Puts in the cache what `event` says of the turns in flight. */
export function applyTurnEvent(queryClient: QueryClient, event: TurnEvent) {
  queryClient.setQueryData<ReadonlyArray<LiveTurn>>(liveTurnsKey, (turns = []) =>
    applied(turns, event),
  );
}

/**
 * Forgets every turn in flight: once the stream drops, a turn may end unseen. When it
 * is back, via sends a `turn.started` for each turn still in flight.
 */
export function forgetTurns(queryClient: QueryClient) {
  queryClient.setQueryData<ReadonlyArray<LiveTurn>>(liveTurnsKey, []);
}
