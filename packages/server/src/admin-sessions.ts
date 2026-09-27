import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Clock, Context, Duration, Effect, Layer, Redacted, Ref } from "effect";
import { TooManySignInsError, Unauthorized } from "./admin-api.ts";

/** A session ends this long after sign-in, however much it is used. */
export const SESSION_LIFETIME = Duration.hours(12);

/** A session ends once unused for this long. */
const SESSION_IDLE = Duration.hours(1);

/** How long a failed sign-in takes to answer, to slow down guessing. */
const FAILED_SIGN_IN_DELAY = Duration.seconds(1);

/** After this many failed sign-ins within `FAILURE_WINDOW`, every sign-in is refused. */
const MAX_FAILURES = 10;

const FAILURE_WINDOW = Duration.minutes(1);

/** A signed-in session: when it began and when it was last used, in epoch millis. */
interface Session {
  readonly signedInAt: number;
  readonly usedAt: number;
}

const isLive = ({ signedInAt, usedAt }: Session, now: number) =>
  now - signedInAt < Duration.toMillis(SESSION_LIFETIME) &&
  now - usedAt < Duration.toMillis(SESSION_IDLE);

const sha256 = (value: string) => createHash("sha256").update(value).digest();

const make = (adminKey: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const expected = sha256(Redacted.value(adminKey));
    // Sessions by the SHA-256 of their token, so the tokens themselves are never kept.
    const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
    const failures = yield* Ref.make<ReadonlyArray<number>>([]);

    // Comparing hashes keeps the comparison constant-time whatever the length.
    const matches = (key: Redacted.Redacted<string>) =>
      timingSafeEqual(sha256(Redacted.value(key)), expected);

    const idOf = (token: string) => sha256(token).toString("hex");

    const isAdminKey = (key: Redacted.Redacted<string>) => Effect.sync(() => matches(key));

    const signIn = Effect.fn("AdminSessions.signIn")(function* (key: Redacted.Redacted<string>) {
      const now = yield* Clock.currentTimeMillis;

      // Checked and counted in one step, so failures that arrive together all count.
      const outcome = yield* Ref.modify(failures, (all) => {
        const recent = all.filter((at) => now - at < Duration.toMillis(FAILURE_WINDOW));

        if (recent.length >= MAX_FAILURES) return ["throttled", recent] as const;

        return matches(key) ? (["ok", recent] as const) : (["wrong", [...recent, now]] as const);
      });

      if (outcome === "throttled") {
        return yield* new TooManySignInsError({ message: "Too many failed sign-ins; try later" });
      }

      if (outcome === "wrong") {
        yield* Effect.logWarning("Failed admin sign-in: wrong admin key");
        yield* Effect.sleep(FAILED_SIGN_IN_DELAY);

        return yield* new Unauthorized({ message: "Wrong admin key" });
      }

      // 256 bits from the OS CSPRNG, as session tokens are secrets.
      const token = randomBytes(32).toString("base64url");
      yield* Ref.update(sessions, (all) =>
        new Map([...all].filter(([, session]) => isLive(session, now))).set(idOf(token), {
          signedInAt: now,
          usedAt: now,
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
      Ref.update(sessions, (all) => {
        const next = new Map(all);
        next.delete(idOf(Redacted.value(token)));

        return next;
      });

    return { isAdminKey, signIn, verify, signOut };
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
     * A new session's token, for the admin key. A wrong key is answered only after a
     * delay, and after too many of them in a minute every sign-in is refused for a while.
     */
    readonly signIn: (
      key: Redacted.Redacted<string>,
    ) => Effect.Effect<Redacted.Redacted<string>, Unauthorized | TooManySignInsError>;
    /** Whether `token` is a live session's, which counts as using it. */
    readonly verify: (token: Redacted.Redacted<string>) => Effect.Effect<boolean>;
    /** Ends `token`'s session, if there is one. */
    readonly signOut: (token: Redacted.Redacted<string>) => Effect.Effect<void>;
  }
>()("via/AdminSessions") {
  static readonly layer = (adminKey: Redacted.Redacted<string>) =>
    Layer.effect(AdminSessions, make(adminKey));
}
