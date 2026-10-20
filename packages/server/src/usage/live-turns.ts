// The turns via is handling now, as `GET /admin/events` sends them. Its schemas import
// only `effect` and `@via/usage/entry`, so the admin API's contract can include them.
import { Context, Effect, HashMap, Layer, PubSub, Ref, Schema, Semaphore, Stream } from "effect";
import { RequestAttempt, UsageEntry } from "@via/usage/entry";

const Nullable = <S extends Schema.Top>(schema: S) => Schema.OptionFromNullOr(schema);

/**
 * An upstream attempt still under way: sent, perhaps answered, not yet ended, so it
 * has no duration or outcome yet.
 */
const OpenAttempt = Schema.Struct({
  state: Schema.Literal("open"),
  requestId: Schema.String,
  /** Its place among the request's attempts, from 0. */
  seq: Schema.Finite,
  /** When via sent it, in epoch milliseconds. */
  startedAt: Schema.Finite,
  provider: Schema.String,
  model: Schema.String,
  accountId: Nullable(Schema.String),
  accountLabel: Nullable(Schema.String),
  /** The status the upstream answered with, once it has. */
  status: Nullable(Schema.Finite),
  /** From `startedAt` to the first chunk of a streamed answer, once it came. */
  firstChunkMs: Nullable(Schema.Finite),
});

/** An attempt that ended before its turn did: one via moved on from. */
const EndedAttempt = Schema.Struct({ state: Schema.Literal("ended"), ...RequestAttempt.fields });

/** An upstream attempt of a turn in flight, as it stands now. */
export const LiveAttempt = Schema.Union([OpenAttempt, EndedAttempt]);

export type LiveAttempt = typeof LiveAttempt.Type;

/** A request via is handling now, a turn of its conversation. Prompts and answers aren't in it. */
export const LiveTurn = Schema.Struct({
  requestId: Schema.String,
  /** When the request came in, in epoch milliseconds. */
  at: Schema.Finite,
  /** The model the client asked for. */
  model: Schema.String,
  conversationId: Nullable(Schema.String),
  parentConversationId: Nullable(Schema.String),
  agentType: Nullable(Schema.String),
  /** The harness that sent it, as its User-Agent names it. */
  client: Nullable(Schema.String),
  keyName: Nullable(Schema.String),
  /** Its upstream attempts so far, in order. */
  attempts: Schema.Array(LiveAttempt),
});

export type LiveTurn = typeof LiveTurn.Type;

/** A turn that ended, as the usage history keeps it. */
const EndedTurn = Schema.Struct({ entry: UsageEntry, attempts: Schema.Array(RequestAttempt) });

/** Every event about the turns in flight, as `GET /admin/events` sends it. */
export const TurnEvent = Schema.Union([
  /** A turn started, or, to a listener that connects, is in flight. */
  Schema.Struct({ event: Schema.Literal("turn.started"), data: Schema.fromJsonString(LiveTurn) }),
  /** An attempt of a turn in flight started, was answered, sent its first chunk, or ended. */
  Schema.Struct({
    event: Schema.Literal("turn.attempt"),
    data: Schema.fromJsonString(LiveAttempt),
  }),
  /** A turn ended, however it did; it is in the usage history now. */
  Schema.Struct({ event: Schema.Literal("turn.ended"), data: Schema.fromJsonString(EndedTurn) }),
]);

export type TurnEvent = typeof TurnEvent.Type;

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
    readonly end: (ended: typeof EndedTurn.Type) => Effect.Effect<void>;
    /**
     * A `turn.started` for each turn in flight now, its attempts so far included, then
     * every event as it comes.
     */
    readonly events: Stream.Stream<TurnEvent>;
  }
>()("via/LiveTurns") {
  static readonly layer = Layer.effect(LiveTurns, make);
}
