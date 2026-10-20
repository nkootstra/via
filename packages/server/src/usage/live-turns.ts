import { Context, Effect, HashMap, Layer, PubSub, Ref, Semaphore, Stream } from "effect";
import type { EndedTurn, LiveAttempt, LiveTurn, TurnEvent } from "./turn-events.ts";

/** How many turns via keeps in flight at most; one past it isn't shown until it ends. */
const CAPACITY = 1_000;

/** How many events a listener can fall behind by; it loses the oldest past that. */
const BACKLOG = 1_024;

const make = Effect.gen(function* () {
  const turns = yield* Ref.make(HashMap.empty<string, LiveTurn>());
  const events = yield* PubSub.sliding<TurnEvent>(BACKLOG);
  // A change and its event, and a listener's snapshot and subscription, happen as one:
  // a listener gets every change after its snapshot, and none twice.
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);

  /** Changes the turn `requestId` by `change`, while it is in flight, and sends `event`. */
  const update = (requestId: string, change: (turn: LiveTurn) => LiveTurn, event: TurnEvent) =>
    locked(
      Effect.flatMap(Ref.get(turns), (now) =>
        HashMap.has(now, requestId)
          ? Effect.andThen(
              Ref.set(turns, HashMap.modify(now, requestId, change)),
              PubSub.publish(events, event),
            )
          : Effect.void,
      ),
    );

  return LiveTurns.of({
    start: (turn) =>
      locked(
        Effect.flatMap(Ref.get(turns), (now) =>
          HashMap.size(now) >= CAPACITY || HashMap.has(now, turn.requestId)
            ? Effect.void
            : Effect.andThen(
                Ref.set(turns, HashMap.set(now, turn.requestId, turn)),
                PubSub.publish(events, { event: "turn.started", data: turn }),
              ),
        ),
      ),
    attempt: (attempt) =>
      update(
        attempt.requestId,
        (turn) => ({
          ...turn,
          attempts: [...turn.attempts.filter(({ seq }) => seq !== attempt.seq), attempt],
        }),
        { event: "turn.attempt", data: attempt },
      ),
    end: (ended) =>
      locked(
        Effect.flatMap(Ref.get(turns), (now) =>
          HashMap.has(now, ended.entry.requestId)
            ? Effect.andThen(
                Ref.set(turns, HashMap.remove(now, ended.entry.requestId)),
                PubSub.publish(events, { event: "turn.ended", data: ended }),
              )
            : Effect.void,
        ),
      ),
    events: Stream.unwrap(
      locked(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(events);

          const inFlight = [...HashMap.values(yield* Ref.get(turns))].toSorted(
            (a, b) => a.at - b.at,
          );

          return Stream.concat(
            Stream.fromIterable(
              inFlight.map((turn): TurnEvent => ({ event: "turn.started", data: turn })),
            ),
            Stream.fromSubscription(subscription),
          );
        }),
      ),
    ),
  });
});

/**
 * The turns via is handling now: kept in memory only, from when a request names its
 * model until it ends, however it does, and sent as events to whoever listens. A
 * listener that falls behind loses the oldest events; it never holds a request up.
 */
export class LiveTurns extends Context.Service<
  LiveTurns,
  {
    /** Shows `turn` as in flight, unless {@link CAPACITY} turns already are. */
    readonly start: (turn: LiveTurn) => Effect.Effect<void>;
    /** Shows how an attempt of a turn in flight stands now. */
    readonly attempt: (attempt: LiveAttempt) => Effect.Effect<void>;
    /** Shows that a turn ended, as `ended`, and forgets it. */
    readonly end: (ended: EndedTurn) => Effect.Effect<void>;
    /**
     * A `turn.started` for each turn in flight now, its attempts so far included, then
     * every event as it comes.
     */
    readonly events: Stream.Stream<TurnEvent>;
  }
>()("via/LiveTurns") {
  static readonly layer = Layer.effect(LiveTurns, make);
}
