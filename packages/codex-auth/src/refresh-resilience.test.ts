import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, PlatformError } from "effect";
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

  it.effect("keeps rotated tokens it can't save, refreshes with them and saves them later", () =>
    Effect.gen(function* () {
      const authDir = yield* tempAuthDir;
      yield* seedAccount(authDir, "a", { expiresAt: 0 });
      const disk = { failures: Infinity };
      const { auth, used } = rotatingIssuer();

      yield* Effect.gen(function* () {
        const store = yield* AccountStore;
        const tokens = yield* AccountTokens;

        const first = yield* tokens.fresh(yield* store.find("a"));
        expect(first.accessToken).toBe("at-2");

        // Codex refuses the new access token: the next refresh must spend "rt-2", not "rt-1".
        const second = yield* tokens.refreshRejected("a", "at-2");
        expect(second.accessToken).toBe("at-3");
        expect(used).toEqual(["rt-1", "rt-2"]);

        disk.failures = 0;
        const third = yield* tokens.fresh(yield* store.find("a"));

        expect(third.accessToken).toBe("at-3");
        expect(used).toEqual(["rt-1", "rt-2"]);
        expect((yield* store.find("a")).refreshToken).toBe("rt-3");
      }).pipe(
        Effect.provide(tokensLayer(authDir, auth, yield* flakyDisk(authDir, disk))),
        TestClock.withLive,
      );
    }),
  );

  it.effect("two processes refreshing the same account at once spend its refresh token once", () =>
    Effect.gen(function* () {
      const authDir = yield* tempAuthDir;
      yield* seedAccount(authDir, "a", { expiresAt: 0 });
      const { auth, used } = rotatingIssuer();

      // Two layers are two processes, each with its own in-process locks, as `via accounts
      // status` next to a running `via serve` are.
      const processAt = Layer.build(tokensLayer(authDir, auth)).pipe(
        Effect.map(Context.get(AccountTokens)),
      );

      const serve = yield* processAt;
      const cli = yield* processAt;

      const stored = yield* Effect.flatMap(Layer.build(AccountStore.layer(authDir)), (context) =>
        Context.get(context, AccountStore).find("a"),
      );

      // Live time: a process waiting on the other's lock file polls for it in real time.
      const fresh = yield* TestClock.withLive(
        Effect.all([serve.fresh(stored), cli.fresh(stored)], { concurrency: "unbounded" }),
      );

      expect(fresh.map((account) => account.accessToken)).toEqual(["at-2", "at-2"]);
      expect(used).toEqual(["rt-1"]);
    }),
  );

  it.effect("a refresh token another process already spent gives the tokens it saved", () =>
    Effect.gen(function* () {
      const authDir = yield* tempAuthDir;
      yield* seedAccount(authDir, "a", { expiresAt: 0 });

      const other = yield* Effect.map(Layer.build(AccountStore.layer(authDir)), (context) =>
        Context.get(context, AccountStore),
      );

      // Another process, one that doesn't take the lock, refreshes "a" and saves its rotation
      // just before this one's refresh reaches the issuer.
      const auth = CodexAuth.of({
        ...rotatingIssuer().auth,
        refresh: () =>
          other
            .saveRefreshed(
              "a",
              tokensFor("a", { accessToken: "at-2", refreshToken: "rt-2", expiresAt: 1e15 }),
            )
            .pipe(
              // The other process's save is part of the test's setup.
              Effect.orDie,
              Effect.andThen(new RefreshRejectedError({ code: "refresh_token_reused" })),
            ),
      });

      const fresh = yield* Effect.flatMap(AccountStore, (store) => store.find("a")).pipe(
        Effect.flatMap((account) =>
          Effect.flatMap(AccountTokens, (tokens) => tokens.fresh(account)),
        ),
        Effect.provide(tokensLayer(authDir, auth)),
      );

      expect(fresh).toMatchObject({ accessToken: "at-2", refreshToken: "rt-2" });
    }),
  );

  it.effect("a login replaces rotated tokens kept in memory", () =>
    Effect.gen(function* () {
      const authDir = yield* tempAuthDir;
      yield* seedAccount(authDir, "a", { expiresAt: 0 });
      const disk = { failures: Infinity };
      const { auth } = rotatingIssuer();

      yield* Effect.gen(function* () {
        const store = yield* AccountStore;
        const tokens = yield* AccountTokens;
        yield* tokens.fresh(yield* store.find("a"));

        disk.failures = 0;
        yield* store.save(tokensFor("a", { accessToken: "at-login", refreshToken: "rt-login" }));
        const fresh = yield* tokens.refreshRejected("a", "at-2");

        expect(fresh.accessToken).toBe("at-login");
        expect((yield* store.find("a")).refreshToken).toBe("rt-login");
      }).pipe(
        Effect.provide(tokensLayer(authDir, auth, yield* flakyDisk(authDir, disk))),
        TestClock.withLive,
      );
    }),
  );
});
