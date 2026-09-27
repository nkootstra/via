import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Arbitrary } from "effect/unstable/arbitrary";
import { TooManySignInsError, Unauthorized } from "./admin-api.ts";
import { AdminSessions } from "./admin-sessions.ts";

const adminKey = Redacted.make("admin-key-that-is-long-enough-000");

const wrongKey = Redacted.make("not-the-admin-key");

const sessions = AdminSessions.layer(adminKey);

/** Signs in with `key`, moving the test clock past the delay a failed sign-in takes. */
const signIn = (key: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild((yield* AdminSessions).signIn(key));
    yield* TestClock.adjust("1 second");

    return yield* Fiber.await(fiber);
  });

describe("AdminSessions", () => {
  it.effect("hands out a session for the admin key, and only for it", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey);
      expect(yield* admin.verify(token)).toBe(true);
      expect(yield* admin.verify(Redacted.make("made-up"))).toBe(false);
      expect(yield* admin.verify(Redacted.make(""))).toBe(false);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("hands out a different 256-bit token each time", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const first = Redacted.value(yield* admin.signIn(adminKey));
      const second = Redacted.value(yield* admin.signIn(adminKey));
      expect(first).not.toBe(second);
      expect(Buffer.from(first, "base64url")).toHaveLength(32);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("checks the admin key as a bearer credential", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      expect(yield* admin.isAdminKey(adminKey)).toBe(true);
      expect(yield* admin.isAdminKey(wrongKey)).toBe(false);
      expect(yield* admin.isAdminKey(Redacted.make(""))).toBe(false);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("answers a wrong key only after a fixed delay", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* AdminSessions).signIn(wrongKey));
      yield* TestClock.adjust("999 millis");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 milli");
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(Schema.is(Unauthorized)(error)).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("refuses every sign-in for a minute after ten failed ones", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;

      for (let attempt = 0; attempt < 10; attempt++) {
        expect(Exit.isFailure(yield* signIn(wrongKey))).toBe(true);
      }

      const refused = yield* Effect.flip(admin.signIn(adminKey));
      expect(Schema.is(TooManySignInsError)(refused)).toBe(true);
      // The first failure was ten seconds ago, so it drops out of the minute after fifty more.
      yield* TestClock.adjust("50 seconds");
      expect(yield* admin.verify(yield* admin.signIn(adminKey))).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("counts failures that arrive together", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;

      const fibers = yield* Effect.forEach(Array.from({ length: 12 }), () =>
        Effect.forkChild(admin.signIn(wrongKey)),
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
      const token = yield* admin.signIn(adminKey);
      const other = yield* admin.signIn(adminKey);
      yield* admin.signOut(token);
      expect(yield* admin.verify(token)).toBe(false);
      expect(yield* admin.verify(other)).toBe(true);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("ends a session left unused for an hour", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey);
      yield* TestClock.adjust("59 minutes");
      expect(yield* admin.verify(token)).toBe(true);
      yield* TestClock.adjust("1 hour");
      expect(yield* admin.verify(token)).toBe(false);
    }).pipe(Effect.provide(sessions)),
  );

  it.effect("ends a session 12 hours after sign-in, however much it is used", () =>
    Effect.gen(function* () {
      const admin = yield* AdminSessions;
      const token = yield* admin.signIn(adminKey);

      for (let use = 0; use < 12; use++) {
        yield* TestClock.adjust("59 minutes");
        expect(yield* admin.verify(token)).toBe(true);
      }

      // 12 × 59 minutes in, and used 12 minutes ago: only the 12 hours end it.
      yield* TestClock.adjust("12 minutes");
      expect(yield* admin.verify(token)).toBe(false);
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
        const token = yield* admin.signIn(adminKey);
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
