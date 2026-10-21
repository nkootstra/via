import { Context, Effect, FiberSet, Layer, Semaphore } from "effect";

const make = Effect.gen(function* () {
  const fibers = yield* FiberSet.make<void>();
  // Added after the set, so it runs before the set's own finalizer interrupts what is left.
  yield* Effect.addFinalizer(() => FiberSet.awaitEmpty(fibers));
  // One at a time: redacting a failed turn's body is work on the one thread every request shares.
  const one = yield* Semaphore.make(1);

  return Settling.of({
    settle: (effect) => Effect.asVoid(FiberSet.run(fibers, one.withPermits(1)(effect))),
  });
});

/**
 * Settles each request once its answer is out: keeps it in the usage history, captures it
 * and logs its line, apart from the request, so its client never waits for that. Requests
 * settle one at a time, in the order they ended, and via lets every one finish before it stops.
 */
export class Settling extends Context.Service<
  Settling,
  {
    /** Runs `effect` apart from the request, after those settling before it. */
    readonly settle: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  }
>()("via/Settling") {
  static readonly layer = Layer.effect(Settling, make);
}
