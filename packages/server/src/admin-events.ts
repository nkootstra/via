import { UsageSnapshots } from "@via/account-pool";
import { AccountStore } from "@via/codex-auth";
import { KeyStore } from "@via/keys";
import { PoolStates } from "@via/pool";
import { OpencodeGoAccounts } from "@via/providers";
import { Clock, Duration, Effect, FiberHandle, Queue, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { UsageHistory } from "@via/usage";
import { type AdminState, StateEvent } from "./admin-api.ts";
import { adminState, type StateOptions } from "./admin-state.ts";

/** How long a change waits for the ones that come with it, so a burst goes out as one state. */
const COALESCE = Duration.millis(200);

/**
 * How long a change to the usage history waits for the ones that come with it:
 * while requests stream in, a page fetches the history at most once a second.
 */
const HISTORY_COALESCE = Duration.seconds(1);

/**
 * How often the state is looked at again without a signal. A change another
 * process makes, such as `via accounts label`, shows within this, and usage a
 * minute old is refreshed while a page listens, as it was when pages polled.
 */
const RESYNC = Duration.seconds(15);

/** A signal whenever something the admin state shows may have changed, and every {@link RESYNC}. */
const signals = Effect.gen(function* () {
  const sources = [
    (yield* UsageSnapshots).changes,
    Stream.map((yield* PoolStates).changes, () => undefined),
    (yield* AccountStore).changes,
    (yield* OpencodeGoAccounts).changes,
    (yield* KeyStore).changes,
    Stream.tick(RESYNC),
  ];

  return Stream.mergeAll(sources, { concurrency: "unbounded" });
});

/** When `state` next changes on its own after `now`: the first cooldown or used-up budget to end. */
const nextEnd = (state: typeof AdminState.Type, now: number) => {
  const ends = [...state.pool.accounts, ...state.pool.opencodeGo, ...state.pool.providers]
    .flatMap(({ state: current }) => ("until" in current ? [Date.parse(current.until)] : []))
    .filter((end) => end > now);

  return ends.length === 0 ? undefined : Math.min(...ends);
};

const encodeEvent = Schema.encodeEffect(StateEvent);

const encoder = new TextEncoder();

/**
 * The admin state as server-sent `state` events: at once, then whenever it
 * changes, which the services signal and a cooldown's end brings on its own. A
 * burst of changes goes out as one event, {@link COALESCE} after the first, and
 * a state the same as the last isn't sent again. Everything it listens to is
 * let go when the stream ends, as it does when the page goes away.
 */
const stateEvents = (options: StateOptions) =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Holds one signal at most: however many come while a state is built, one more follows.
      const wake = yield* Queue.sliding<void>(1);
      const signal = Queue.offer(wake, undefined);
      yield* Effect.forkScoped(Stream.runForEach(yield* signals, () => signal));
      const ending = yield* FiberHandle.make();

      /** The state now, with a signal set for when it next changes on its own. */
      const look = Effect.gen(function* () {
        const state = yield* adminState(options);
        const now = yield* Clock.currentTimeMillis;
        const end = nextEnd(state, now);

        if (end === undefined) yield* FiberHandle.clear(ending);
        else yield* FiberHandle.run(ending, Effect.andThen(Effect.sleep(end - now), signal));

        return state;
      });

      const afterChange = Queue.take(wake).pipe(
        Effect.andThen(Effect.sleep(COALESCE)),
        Effect.andThen(Queue.clear(wake)),
        Effect.andThen(look),
      );

      return Stream.concat(Stream.fromEffect(look), Stream.fromEffectRepeat(afterChange));
    }),
  ).pipe(
    // via builds the state itself, so failing to encode it is a bug.
    Stream.mapEffect((state) => Effect.orDie(encodeEvent({ event: "state", data: state }))),
    Stream.changesWith((a, b) => a.data === b.data),
    Stream.map(({ event, data }) =>
      encoder.encode(Sse.encoder.write(Sse.Event.make({ event, id: undefined, data }))),
    ),
  );

/** An event as the stream sends it, in its SSE framing. */
const frame = (event: string, data: string) =>
  encoder.encode(Sse.encoder.write(Sse.Event.make({ event, id: undefined, data })));

/**
 * A `history` event whenever the usage history changes, a burst of changes as
 * one, {@link HISTORY_COALESCE} after the first. Nothing is sent at once: the
 * page fetched the history as it opened.
 */
const historyEvents = Stream.unwrap(
  Effect.gen(function* () {
    const history = yield* UsageHistory;
    // Holds one signal at most: however many come in the meantime, one more event follows.
    const wake = yield* Queue.sliding<void>(1);

    yield* Effect.forkScoped(
      Stream.runForEach(Stream.drop(history.changes, 1), () => Queue.offer(wake, undefined)),
    );

    return Stream.fromEffectRepeat(
      Queue.take(wake).pipe(
        Effect.andThen(Effect.sleep(HISTORY_COALESCE)),
        Effect.andThen(Queue.clear(wake)),
        Effect.as(frame("history", "changed")),
      ),
    );
  }),
);

/**
 * The admin UI's live updates: the admin state as `state` events (see
 * {@link stateEvents}), and a `history` event whenever the usage history
 * changes (see {@link historyEvents}).
 */
export const adminEvents = (options: StateOptions) =>
  Stream.merge(stateEvents(options), historyEvents);
