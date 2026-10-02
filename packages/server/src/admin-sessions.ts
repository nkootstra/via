import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Clock, Context, Deferred, Duration, Effect, Layer, Redacted, Ref } from "effect";
import { TooManySignInsError, Unauthorized } from "./admin-api.ts";
import { type Failures, SIGN_IN_LIMITS, attempt } from "./sign-in-throttle.ts";

/** A session ends this long after sign-in, however much it is used. */
export const SESSION_LIFETIME = Duration.hours(12);

/** A session ends once unused for this long. */
const SESSION_IDLE = Duration.hours(1);

/** How long a wrong or refused sign-in takes to answer, to slow down guessing. */
const FAILED_SIGN_IN_DELAY = Duration.seconds(1);

/**
 * A signed-in session: when it began and when it was last used, in epoch millis,
 * and `signedOut`, done once it is signed out.
 */
interface Session {
  readonly signedInAt: number;
  readonly usedAt: number;
  readonly signedOut: Deferred.Deferred<void>;
}

/** When `session` runs out unless it is used again, in epoch millis. */
const endsAt = ({ signedInAt, usedAt }: Session) =>
  Math.min(
    signedInAt + Duration.toMillis(SESSION_LIFETIME),
    usedAt + Duration.toMillis(SESSION_IDLE),
  );

const isLive = (session: Session, now: number) => now < endsAt(session);

const sha256 = (value: string) => createHash("sha256").update(value).digest();

const make = (adminKey: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const expected = sha256(Redacted.value(adminKey));
    // Sessions by the SHA-256 of their token, so the tokens themselves are never kept.
    const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
    const failures = yield* Ref.make<Failures>(new Map());

    // Comparing hashes keeps the comparison constant-time whatever the length.
    const matches = (key: Redacted.Redacted<string>) =>
      timingSafeEqual(sha256(Redacted.value(key)), expected);

    const idOf = (token: string) => sha256(token).toString("hex");

    const isAdminKey = (key: Redacted.Redacted<string>) => Effect.sync(() => matches(key));

    const signIn = Effect.fn("AdminSessions.signIn")(function* (
      key: Redacted.Redacted<string>,
      client: string,
    ) {
      const now = yield* Clock.currentTimeMillis;

      // Checked and counted in one step, so failures that arrive together all count.
      const outcome = yield* Ref.modify(failures, (all) =>
        attempt(SIGN_IN_LIMITS, all, { client, now, matches: matches(key) }),
      );

      if (outcome === "throttled") {
        yield* Effect.sleep(FAILED_SIGN_IN_DELAY);

        return yield* new TooManySignInsError({ message: "Too many failed sign-ins; try later" });
      }

      if (outcome === "wrong") {
        yield* Effect.logWarning("Failed admin sign-in: wrong admin key");
        yield* Effect.sleep(FAILED_SIGN_IN_DELAY);

        return yield* new Unauthorized({ message: "Wrong admin key" });
      }

      // 256 bits from the OS CSPRNG, as session tokens are secrets.
      const token = randomBytes(32).toString("base64url");
      const signedOut = yield* Deferred.make<void>();
      yield* Ref.update(sessions, (all) =>
        new Map([...all].filter(([, session]) => isLive(session, now))).set(idOf(token), {
          signedInAt: now,
          usedAt: now,
          signedOut,
        }),
      );

      return Redacted.make(token);
    });

    const verify = Effect.fn("AdminSessions.verify")(function* (token: Redacted.Redacted<string>) {
      const now = yield* Clock.currentTimeMillis;
      const id = idOf(Redacted.value(token));

      return yield* Ref.modify(sessions, (all): [boolean, ReadonlyMap<string, Session>] => {
        const session = all.get(id);

        if (session === undefined) return [false, all];
        const next = new Map(all);

        if (!isLive(session, now)) {
          next.delete(id);

          return [false, next];
        }

        return [true, next.set(id, { ...session, usedAt: now })];
      });
    });

    const signOut = (token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const id = idOf(Redacted.value(token));

        const ended = yield* Ref.modify(
          sessions,
          (all): [Session | undefined, ReadonlyMap<string, Session>] => {
            const next = new Map(all);
            next.delete(id);

            return [all.get(id), next];
          },
        );

        if (ended !== undefined) yield* Deferred.succeed(ended.signedOut, undefined);
      });

    // Looked at again whenever the session would have run out: using it since moves that on.
    const ended = (token: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const id = idOf(Redacted.value(token));

        for (;;) {
          const session = (yield* Ref.get(sessions)).get(id);
          const now = yield* Clock.currentTimeMillis;

          if (session === undefined || !isLive(session, now)) return;

          yield* Effect.raceFirst(
            Deferred.await(session.signedOut),
            Effect.sleep(endsAt(session) - now),
          );
        }
      });

    return { isAdminKey, signIn, verify, signOut, ended };
  });

/**
 * Sign-ins to the admin API with the admin key, and the sessions they start,
 * kept in memory: a restart ends every session.
 */
export class AdminSessions extends Context.Service<
  AdminSessions,
  {
    /** Whether `key` is the admin key. */
    readonly isAdminKey: (key: Redacted.Redacted<string>) => Effect.Effect<boolean>;
    /**
     * A new session's token, for the admin key sent by `client`, the address it
     * connected from. A wrong key is answered only after a delay. After too many
     * of them in a minute, the client's sign-ins are refused for a while, after
     * the same delay; after far more from all clients, everyone's are.
     */
    readonly signIn: (
      key: Redacted.Redacted<string>,
      client: string,
    ) => Effect.Effect<Redacted.Redacted<string>, Unauthorized | TooManySignInsError>;
    /** Whether `token` is a live session's, which counts as using it. */
    readonly verify: (token: Redacted.Redacted<string>) => Effect.Effect<boolean>;
    /** Ends `token`'s session, if there is one. */
    readonly signOut: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
    /** Waits until `token`'s session ends, without using it; at once if it has. */
    readonly ended: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
  }
>()("via/AdminSessions") {
  static readonly layer = (adminKey: Redacted.Redacted<string>) =>
    Layer.effect(AdminSessions, make(adminKey));
}
