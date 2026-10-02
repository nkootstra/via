import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import {
  type Account,
  AccountNotFoundError,
  AccountStore,
  AccountTokens,
  CodexAuth,
} from "@via/codex-auth";
import { seedAccount, startFakeIssuer } from "@via/codex-auth/testing";
import { CorruptFileError, FileLockTimeoutError } from "@via/config";
import { PoolStates } from "@via/pool";
import { Effect, FileSystem, Layer, Logger, Option, PlatformError } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AccountPool } from "./account-pool.ts";
import { collectLogs } from "./testing/logs.ts";

const account: Account = {
  id: "id-a",
  label: "a@example.com",
  email: "a@example.com",
  plan: "pro",
  accountId: "acc-a",
  accessToken: "at",
  refreshToken: "rt",
  idToken: "it",
  expiresAt: 0,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

layer(BunFileSystem.layer)("choosing an account", (it) => {
  it.effect("moves on to the next account when the first one's refresh is rejected", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

      const issuer = yield* startFakeIssuer({
        refreshResponse: { status: 400, body: { error: "invalid_grant" } },
      });

      // "a" was added first, so it serves first, but its token has expired.
      yield* seedAccount(dir, "a", { expiresAt: 0 });
      yield* seedAccount(dir, "b", { createdAt: "2026-01-02T00:00:00.000Z" });
      const logs = collectLogs();

      const poolLayer = AccountPool.layer.pipe(
        Layer.provide(AccountTokens.layer),
        Layer.provide([AccountStore.layer(dir), CodexAuth.layer(issuer)]),
        Layer.provide([PoolStates.layer, FetchHttpClient.layer]),
      );

      const next = yield* Effect.gen(function* () {
        return yield* (yield* AccountPool).next(() => true, Option.none());
      }).pipe(Effect.provide([poolLayer, Logger.layer([logs.logger])]));

      expect(Option.map(next, ({ id }) => id)).toEqual(Option.some("b"));
      expect(yield* logs.logged("a is locked out")).toMatchObject({ level: "Warn" });
    }),
  );

  it.effect("warns only when a cooldown takes an account out of rotation for longer", () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

      // Cooling down reads no account and refreshes no token, so nothing answers at the issuer.
      const poolLayer = AccountPool.layer.pipe(
        Layer.provide(AccountTokens.layer),
        Layer.provide([AccountStore.layer(dir), CodexAuth.layer("http://127.0.0.1:1")]),
        Layer.provide([PoolStates.layer, FetchHttpClient.layer]),
      );

      const lines: Array<string> = [];

      const logger = Logger.make(({ message }) => {
        lines.push(String(message));
      });

      const cooled = yield* Effect.gen(function* () {
        const pool = yield* AccountPool;

        return yield* Effect.all([
          pool.coolDown(account, 60_000, "rate_limited"),
          pool.coolDown(account, 60_000, "rate_limited"),
          pool.coolDown(account, 30_000, "rate_limited"),
        ]);
      }).pipe(Effect.provide([poolLayer, Logger.layer([logger])]));

      expect(cooled).toEqual([true, false, false]);
      expect(lines.filter((line) => line.includes("is cooling down"))).toHaveLength(1);
    }),
  );

  /**
   * A pool over accounts "a" and then "b" (or `names`), whose token store fails
   * every refresh of "a" with `error`, and the logs it writes.
   */
  const failingRefreshOfA = (
    error: Effect.Error<ReturnType<AccountTokens["Service"]["fresh"]>>,
    names: ReadonlyArray<string> = ["a", "b"],
  ) =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

      for (const [index, name] of names.entries()) {
        yield* seedAccount(dir, name, { createdAt: `2026-01-0${index + 1}T00:00:00.000Z` });
      }

      const refresh = (account: Account) =>
        account.id === "a" ? Effect.fail(error) : Effect.succeed(account);
      const tokens = Layer.succeed(AccountTokens, {
        fresh: refresh,
        refreshRejected: (id: string) => refresh({ ...account, id }),
      });
      const logs = collectLogs();

      const poolLayer = AccountPool.layer.pipe(
        Layer.provide([tokens, AccountStore.layer(dir), PoolStates.layer]),
        Layer.provide(Logger.layer([logs.logger])),
      );

      return { poolLayer, logs };
    });

  it.effect.each([
    new FileLockTimeoutError({ path: "/auth/a.json" }),
    new CorruptFileError({ path: "/auth/a.json", reason: "not JSON" }),
    PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: "/auth/a.json",
    }),
  ])("rests an account for a minute when its refresh fails with $_tag, and moves on", (error) =>
    Effect.gen(function* () {
      const { poolLayer, logs } = yield* failingRefreshOfA(error);

      const [next, wait] = yield* Effect.gen(function* () {
        const pool = yield* AccountPool;
        const next = yield* pool.next(() => true, Option.none());

        return [next, yield* pool.waitFor(() => true)] as const;
      }).pipe(Effect.provide([poolLayer, Logger.layer([logs.logger])]));

      expect(Option.map(next, ({ id }) => id)).toEqual(Option.some("b"));
      expect(wait).toEqual(Option.some(60_000));
      expect(yield* logs.logged("a is cooling down")).toMatchObject({ level: "Warn" });
    }),
  );

  it.effect("skips an account removed while its token was refreshed, without a cooldown", () =>
    Effect.gen(function* () {
      const { poolLayer, logs } = yield* failingRefreshOfA(
        new AccountNotFoundError({ query: "a" }),
      );

      const [next, wait] = yield* Effect.gen(function* () {
        const pool = yield* AccountPool;
        const next = yield* pool.next(() => true, Option.none());

        return [next, yield* pool.waitFor(() => true)] as const;
      }).pipe(Effect.provide([poolLayer, Logger.layer([logs.logger])]));

      expect(Option.map(next, ({ id }) => id)).toEqual(Option.some("b"));
      expect(wait).toEqual(Option.none());
      expect(yield* logs.logged("Skipping a")).toMatchObject({ level: "Warn" });
    }),
  );

  it.effect("finds no account when the only one keeps vanishing on refresh", () =>
    Effect.gen(function* () {
      const { poolLayer } = yield* failingRefreshOfA(new AccountNotFoundError({ query: "a" }), [
        "a",
      ]);

      const next = yield* Effect.gen(function* () {
        return yield* (yield* AccountPool).next(() => true, Option.none());
      }).pipe(Effect.provide(poolLayer));

      expect(next).toEqual(Option.none());
    }),
  );

  it.effect("sets an account aside when its refresh after a refused token fails", () =>
    Effect.gen(function* () {
      const { poolLayer } = yield* failingRefreshOfA(
        new FileLockTimeoutError({ path: "/auth/a.json" }),
      );

      const [refreshed, wait] = yield* Effect.gen(function* () {
        const pool = yield* AccountPool;
        const refreshed = yield* pool.refreshRejected({ ...account, id: "a" });

        return [refreshed, yield* pool.waitFor(() => true)] as const;
      }).pipe(Effect.provide(poolLayer));

      expect(refreshed).toEqual(Option.none());
      expect(wait).toEqual(Option.some(60_000));
    }),
  );
});
