import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer } from "effect";
import { seedAccount, tokensFor } from "./testing/index.ts";
import { AccountStore, AccountTokens, CodexAuth, RefreshRejectedError } from "./index.ts";

const HOUR = 3_600_000;

/**
 * An issuer in memory: each refresh token works once and is answered with the next ("rt-1",
 * then "rt-2", ...); a reused one is rejected. `onRefresh` runs once the issuer has rotated
 * a token, before its answer reaches via.
 */
const rotatingIssuer = (onRefresh: () => Effect.Effect<void> = () => Effect.void) => {
  const used: Array<string> = [];

  const auth = CodexAuth.of({
    requestDeviceCode: Effect.die("device login is not used here"),
    awaitDeviceTokens: () => Effect.die("device login is not used here"),
    refresh: (current) =>
      Effect.gen(function* () {
        if (used.includes(current.refreshToken)) {
          return yield* new RefreshRejectedError({ code: "refresh_token_reused" });
        }

        used.push(current.refreshToken);
        const n = used.length + 1;
        yield* onRefresh();

        return tokensFor("a", { accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: HOUR });
      }),
  });

  return { auth, used };
};

/** AccountTokens over the accounts in `authDir`, refreshing them at `auth`. */
const tokensLayer = (authDir: string, auth: CodexAuth["Service"]) =>
  AccountTokens.layer.pipe(
    Layer.provideMerge(AccountStore.layer(authDir)),
    Layer.provide(Layer.succeed(CodexAuth, auth)),
  );

const tempAuthDir = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped(),
).pipe(Effect.map((dir) => `${dir}/auth`));

layer(BunFileSystem.layer)("AccountTokens refreshing", (it) => {
  it.effect("saves the rotated tokens even when the caller goes away during the refresh", () =>
    Effect.gen(function* () {
      const authDir = yield* tempAuthDir;
      yield* seedAccount(authDir, "a", { expiresAt: 0 });
      const rotated = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();

      const { auth } = rotatingIssuer(() =>
        Effect.andThen(Deferred.succeed(rotated, undefined), Deferred.await(answer)),
      );

      yield* Effect.gen(function* () {
        const store = yield* AccountStore;
        const tokens = yield* AccountTokens;

        const request = yield* tokens.fresh(yield* store.find("a")).pipe(Effect.forkChild);

        // The client disconnects after the issuer spent "rt-1", before its answer arrives.
        yield* Deferred.await(rotated);
        request.interruptUnsafe();
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.await(request);

        expect((yield* store.find("a")).refreshToken).toBe("rt-2");
      }).pipe(Effect.provide(tokensLayer(authDir, auth)));
    }),
  );
});
