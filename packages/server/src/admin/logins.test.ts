import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { AccountStore } from "@via/codex-auth";
import { type FakeIssuerOptions, withIssuer } from "@via/codex-auth/testing";
import { PoolStates } from "@via/pool";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import { LoginNotFoundError } from "./api.ts";
import { Logins } from "./logins.ts";

const isPending = Schema.is(Schema.Struct({ status: Schema.Literal("pending") }));

/** Runs `body` with Logins against a fake issuer and a fresh account directory. */
const withLogins = <A, E>(options: FakeIssuerOptions, body: Effect.Effect<A, E, Logins>) =>
  withIssuer(options, () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

      return yield* body.pipe(
        Effect.provide(
          Logins.layer.pipe(
            Layer.provide(Layer.mergeAll(AccountStore.layer(`${dir}/auth`), PoolStates.layer)),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(BunFileSystem.layer));

/**
 * Polls a login until it is no longer pending, a turn of the event loop apart,
 * in which the fake issuer's answers come in. It approves at once, so the
 * login needs no test time to end; moving the clock while one of its requests
 * is in flight would run out that request's 30-second timeout before the
 * issuer could answer.
 */
const settled = (id: string) =>
  Effect.yieldNow.pipe(
    Effect.andThen(Effect.flatMap(Logins, (logins) => logins.status(id))),
    Effect.repeat({ until: (login) => !isPending(login) }),
  );

describe("Logins", () => {
  it.effect("keeps a finished login without the account's tokens", () =>
    withLogins(
      {},
      Effect.gen(function* () {
        const { id } = yield* (yield* Logins).start();

        expect(yield* settled(id)).toEqual({
          status: "added",
          account: {
            id: expect.any(String),
            label: "dev@example.com",
            email: "dev@example.com",
            plan: "pro",
            enabled: true,
            createdAt: expect.any(String),
          },
        });
      }),
    ),
  );

  it.effect("forgets a finished login five minutes after it finished", () =>
    withLogins(
      {},
      Effect.gen(function* () {
        const logins = yield* Logins;
        const { id } = yield* logins.start();
        yield* settled(id);

        yield* TestClock.adjust("4 minutes");
        expect(yield* logins.status(id)).toMatchObject({ status: "added" });

        yield* TestClock.adjust("1 minute");
        expect(yield* Effect.flip(logins.status(id))).toEqual(new LoginNotFoundError({ id }));
      }),
    ),
  );

  it.effect("refuses a login while ten others wait for approval", () =>
    withLogins(
      { pendingPolls: Infinity, interval: "5" },
      Effect.gen(function* () {
        const logins = yield* Logins;

        for (let started = 0; started < 10; started++) yield* logins.start();

        const refused = logins.start().pipe(
          Effect.as("started"),
          Effect.catchTag("TooManyLoginsError", () => Effect.succeed("refused")),
        );

        expect(yield* refused).toBe("refused");

        // Each ends when it isn't approved within 15 minutes, and so makes room.
        yield* TestClock.adjust("15 minutes");
        expect(yield* logins.start()).toMatchObject({ userCode: "ABCD-1234" });
      }),
    ),
  );
});
