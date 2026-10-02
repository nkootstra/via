import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, PlatformError } from "effect";
import { TestClock } from "effect/testing";
import { seedAccount, tokensFor } from "./testing/index.ts";
import { AccountStore, AccountTokens, CodexAuth, RefreshRejectedError } from "./index.ts";

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

        return tokensFor("a", { accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: 1e15 });
      }),
  });

  return { auth, used };
};

/**
 * The file system, except that writing account "a" fails while `disk.failures` is above
 * zero, each failure counting it down, as a full disk would.
 */
const flakyDisk = (authDir: string, disk: { failures: number }) =>
  Effect.map(FileSystem.FileSystem, (fs) =>
    Layer.succeed(FileSystem.FileSystem, {
      ...fs,
      rename: (from, to) => {
        if (to !== `${authDir}/a.json` || disk.failures <= 0) return fs.rename(from, to);
        disk.failures -= 1;

        return Effect.fail(
          PlatformError.badArgument({
            module: "FileSystem",
            method: "rename",
            description: "disk full",
          }),
        );
      },
    }),
  );

/** AccountTokens over the accounts in `authDir`, refreshing them at `auth`. */
const tokensLayer = (
  authDir: string,
  auth: CodexAuth["Service"],
  fs: Layer.Layer<FileSystem.FileSystem> | Layer.Layer<never> = Layer.empty,
) =>
  AccountTokens.layer.pipe(
    Layer.provideMerge(AccountStore.layer(authDir).pipe(Layer.provide(fs))),
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

  it.effect("saves the rotated tokens when saving fails at first", () =>
    Effect.gen(function* () {
      const authDir = yield* tempAuthDir;
      yield* seedAccount(authDir, "a", { expiresAt: 0 });
      const disk = yield* flakyDisk(authDir, { failures: 1 });
      const { auth } = rotatingIssuer();

      yield* Effect.gen(function* () {
        const store = yield* AccountStore;
        yield* (yield* AccountTokens).fresh(yield* store.find("a"));

        expect((yield* store.find("a")).refreshToken).toBe("rt-2");
      }).pipe(Effect.provide(tokensLayer(authDir, auth, disk)), TestClock.withLive);
    }),
  );
});
