import { AccountStore, CodexAuth } from "@via/codex-auth";
import { PoolStates } from "@via/pool";
import { Clock, Context, Duration, Effect, Layer, Ref } from "effect";
import { LoginNotFoundError, TooManyLoginsError } from "./admin-api.ts";
import { withoutTokens } from "./admin-state.ts";

/** How long a login that has ended stays around, for the page polling it to hear how. */
const RETENTION = Duration.minutes(5);

/**
 * How many logins may wait for approval at once. Each ends by itself when it
 * isn't approved within 15 minutes.
 */
const MAX_PENDING = 10;

type AdminAccount = ReturnType<typeof withoutTokens>;

/** Where a device-code login started through the admin API stands. Never the account's tokens. */
type LoginState =
  | { readonly status: "pending" }
  | { readonly status: "added"; readonly account: AdminAccount }
  | { readonly status: "updated"; readonly account: AdminAccount }
  | { readonly status: "failed"; readonly error: string };

/** A login, and when it ended, once it has. */
type Login = { readonly state: LoginState; readonly endedAt?: number };

const make = Effect.gen(function* () {
  const auth = yield* CodexAuth;
  const store = yield* AccountStore;
  const states = yield* PoolStates;
  // Logins outlive the request that started them, but not the server.
  const scope = yield* Effect.scope;
  const logins = yield* Ref.make<ReadonlyMap<string, Login>>(new Map());

  /** The logins, without those that ended longer than `RETENTION` ago at `now`. */
  const current = (all: ReadonlyMap<string, Login>, now: number) =>
    new Map(
      [...all].filter(
        ([, { endedAt }]) => endedAt === undefined || now - endedAt < Duration.toMillis(RETENTION),
      ),
    );

  const end = (id: string, state: LoginState) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.update(logins, (all) => new Map(all).set(id, { state, endedAt: now })),
    );

  /** Asks for a device code and waits for its approval in the background. */
  const start = Effect.fn("Logins.start")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const id = crypto.randomUUID();

    // Checked and taken at once, so two logins started together can't both take the last place.
    const admitted = yield* Ref.modify(logins, (all) => {
      const kept = current(all, now);
      const pending = [...kept.values()].filter(({ endedAt }) => endedAt === undefined);

      return pending.length < MAX_PENDING
        ? [true, kept.set(id, { state: { status: "pending" } })]
        : [false, kept];
    });

    if (!admitted) {
      return yield* new TooManyLoginsError({
        message: `${MAX_PENDING} logins are already waiting for approval; approve one or wait for it to expire`,
      });
    }

    const code = yield* auth.requestDeviceCode.pipe(
      Effect.onError(() =>
        Ref.update(logins, (all) => {
          const rest = new Map(all);
          rest.delete(id);

          return rest;
        }),
      ),
    );

    yield* auth.awaitDeviceTokens(code).pipe(
      Effect.flatMap(store.save),
      // Signing an account in again is how a locked-out account gets fixed.
      Effect.tap(({ account }) => states.liftLockOut(account.id)),
      Effect.flatMap(({ account, created }) =>
        end(id, { status: created ? "added" : "updated", account: withoutTokens(account) }),
      ),
      Effect.catch((error) => end(id, { status: "failed", error: error.message })),
      Effect.forkIn(scope),
    );

    return { id, userCode: code.userCode, verificationUrl: code.verificationUrl };
  });

  const status = Effect.fn("Logins.status")(function* (id: string) {
    const now = yield* Clock.currentTimeMillis;

    const login = yield* Ref.modify(logins, (all) => {
      const kept = current(all, now);

      return [kept.get(id), kept];
    });

    return login?.state ?? (yield* new LoginNotFoundError({ id }));
  });

  return { start, status };
});

/** Device-code logins started through the admin API, kept in memory for a while. */
export class Logins extends Context.Service<Logins, Effect.Success<typeof make>>()("via/Logins") {
  static readonly layer = Layer.effect(Logins, make);
}
