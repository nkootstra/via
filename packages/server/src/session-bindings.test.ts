import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { SessionBindings } from "./session-bindings.ts";

const run = <A, E>(body: Effect.Effect<A, E, SessionBindings>) =>
  body.pipe(Effect.provide(SessionBindings.layer));

describe("SessionBindings", () => {
  it.effect("has no binding for a session that was never bound", () =>
    run(
      Effect.gen(function* () {
        const bindings = yield* SessionBindings;
        expect(yield* bindings.get("s1")).toEqual(Option.none());
      }),
    ),
  );

  it.effect("remembers the account that answered a session", () =>
    run(
      Effect.gen(function* () {
        const bindings = yield* SessionBindings;
        yield* bindings.bind("s1", "acc-a");
        expect(yield* bindings.get("s1")).toEqual(Option.some("acc-a"));
      }),
    ),
  );

  it.effect("forgets a session idle for over an hour", () =>
    run(
      Effect.gen(function* () {
        const bindings = yield* SessionBindings;
        yield* bindings.bind("s1", "acc-a");
        yield* TestClock.adjust("61 minutes");
        expect(yield* bindings.get("s1")).toEqual(Option.none());
      }),
    ),
  );

  it.effect("keeps a session alive as long as it keeps being used", () =>
    run(
      Effect.gen(function* () {
        const bindings = yield* SessionBindings;
        yield* bindings.bind("s1", "acc-a");
        yield* TestClock.adjust("59 minutes");
        // Reusing the session before it expires should push its expiry out again.
        yield* bindings.bind("s1", "acc-a");
        yield* TestClock.adjust("59 minutes");
        expect(yield* bindings.get("s1")).toEqual(Option.some("acc-a"));
      }),
    ),
  );
});
