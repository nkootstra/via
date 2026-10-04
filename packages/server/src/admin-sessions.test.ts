import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Arbitrary } from "effect/unstable/arbitrary";
import { TooManySignInsError, Unauthorized } from "./admin-api.ts";
import { AdminSessions } from "./admin-sessions.ts";

const adminKey = Redacted.make("admin-key-that-is-long-enough-000");

const wrongKey = Redacted.make("not-the-admin-key");

const sessions = AdminSessions.layer(adminKey);

/** Signs in with `key` from `client`, moving the test clock past the delay a failed sign-in takes. */
const signIn = (key: Redacted.Redacted<string>, client = "203.0.113.1") =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild((yield* AdminSessions).signIn(key, client));
    yield* TestClock.adjust("1 second");

    return yield* Fiber.await(fiber);
  });

describe("AdminSessions", () => {
  it.effect("hands out a session for the admin key, and only for it", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey, "203.0.113.1");
      expect(yield* admin.verify(token)).toBe(true);
      expect(yield* admin.verify(Redacted.make("made-up"))).toBe(false);
      expect(yield* admin.verify(Redacted.make(""))).toBe(false);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("hands out a different 256-bit token each time", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const first = Redacted.value(yield* admin.signIn(adminKey, "203.0.113.1"));
      const second = Redacted.value(yield* admin.signIn(adminKey, "203.0.113.1"));
      expect(first).not.toBe(second);
      expect(Buffer.from(first, "base64url")).toHaveLength(32);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("checks the admin key as a bearer credential", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      yield* admin.authorize(adminKey, "203.0.113.1");
      const wrong = yield* Effect.flip(admin.authorize(wrongKey, "203.0.113.1"));
      expect(Schema.is(Unauthorized)(wrong)).toBe(true);
      const empty = yield* Effect.flip(admin.authorize(Redacted.make(""), "203.0.113.1"));
      expect(Schema.is(Unauthorized)(empty)).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("answers a wrong key only after a fixed delay", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* AdminSessions).signIn(wrongKey, "203.0.113.1"));
      yield* TestClock.adjust("999 millis");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 milli");
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(Schema.is(Unauthorized)(error)).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("refuses a client's sign-ins for a minute after ten of its failed ones", () =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(Exit.isFailure(yield* signIn(wrongKey, "a"))).toBe(true);
      }

      const refused = yield* Effect.flip(yield* signIn(adminKey, "a"));
      expect(Schema.is(TooManySignInsError)(refused)).toBe(true);
      // The first failure was eleven seconds ago, so it drops out of the minute after 49 more.
      yield* TestClock.adjust("49 seconds");
      expect(Exit.isSuccess(yield* signIn(adminKey, "a"))).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("lets another client sign in while one is refused", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;

      for (let attempt = 0; attempt < 10; attempt++) {
        yield* signIn(wrongKey, "a");
      }

      expect(Exit.isFailure(yield* signIn(adminKey, "a"))).toBe(true);
      expect(yield* admin.verify(yield* admin.signIn(adminKey, "b"))).toBe(true);
      expect(Exit.isFailure(yield* signIn(wrongKey, "b"))).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("answers a refused sign-in after the same delay as a wrong key", () =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 10; attempt++) {
        yield* signIn(wrongKey, "a");
      }

      const fiber = yield* Effect.forkChild((yield* AdminSessions).signIn(adminKey, "a"));
      yield* TestClock.adjust("999 millis");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 milli");
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(Schema.is(TooManySignInsError)(error)).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("keeps counting a client's failures when it signs in in between", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;

      for (let attempt = 0; attempt < 9; attempt++) {
        yield* signIn(wrongKey, "a");
      }

      // Behind a proxy, the admin signing in shares "a" with whoever guesses: it buys them nothing.
      yield* admin.signIn(adminKey, "a");
      yield* signIn(wrongKey, "a");
      const refused = yield* Effect.flip(yield* signIn(adminKey, "a"));
      expect(Schema.is(TooManySignInsError)(refused)).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("counts a client's failures that arrive together", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;

      const fibers = yield* Effect.forEach(Array.from({ length: 12 }), () =>
        Effect.forkChild(admin.signIn(wrongKey, "a")),
      );

      yield* TestClock.adjust("1 second");
      const errors = yield* Effect.forEach(fibers, (fiber) => Effect.flip(Fiber.join(fiber)));

      expect(errors.filter(Schema.is(Unauthorized))).toHaveLength(10);
      expect(errors.filter(Schema.is(TooManySignInsError))).toHaveLength(2);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("ends a session on sign-out", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey, "203.0.113.1");
      const other = yield* admin.signIn(adminKey, "203.0.113.1");
      yield* admin.signOut(token);
      expect(yield* admin.verify(token)).toBe(false);
      expect(yield* admin.verify(other)).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("ends a session left unused for an hour", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey, "203.0.113.1");
      yield* TestClock.adjust("59 minutes");
      expect(yield* admin.verify(token)).toBe(true);
      yield* TestClock.adjust("1 hour");
      expect(yield* admin.verify(token)).toBe(false);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("ends a session 12 hours after sign-in, however much it is used", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey, "203.0.113.1");

      for (let use = 0; use < 12; use++) {
        yield* TestClock.adjust("59 minutes");
        expect(yield* admin.verify(token)).toBe(true);
      }

      // 12 × 59 minutes in, and used 12 minutes ago: only the 12 hours end it.
      yield* TestClock.adjust("12 minutes");
      expect(yield* admin.verify(token)).toBe(false);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("says a session ended once it runs out 12 hours in, however much it is used", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey, "203.0.113.1");
      const ended = yield* Effect.forkChild(admin.ended(token));

      for (let use = 0; use < 12; use++) {
        yield* TestClock.adjust("59 minutes");
        expect(yield* admin.verify(token)).toBe(true);
      }

      yield* TestClock.adjust("11 minutes");
      expect(ended.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(ended);
    }).pipe(Effect.provide(sessions)),
  );

  /** Minutes between two uses of a session: often under the hour it may idle, sometimes not. */
  const gaps = Arbitrary.array(
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65 }))),
    { minLength: 1, maxLength: 40 },
  );

  it.effect.prop(
    "a session lives while used within the hour, and never past 12 hours",
    { gaps },
    ({ gaps: values }) =>
      Effect.gen(function* () {
        const admin = yield* AdminSessions;
        const token = yield* admin.signIn(adminKey, "203.0.113.1");
        let elapsed = Duration.zero;
        let lastUse = Duration.zero;
        let live = true;

        for (const minutes of values) {
          const gap = Duration.minutes(minutes);
          yield* TestClock.adjust(gap);
          elapsed = Duration.sum(elapsed, gap);

          live =
            live &&
            Duration.isLessThan(elapsed, Duration.hours(12)) &&
            Duration.isLessThan(Duration.subtract(elapsed, lastUse), Duration.hours(1));

          if (live) lastUse = elapsed;
          expect(yield* admin.verify(token)).toBe(live);
        }
      }).pipe(Effect.provide(sessions)),
  );
});
