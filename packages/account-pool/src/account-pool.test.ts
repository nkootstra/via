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

/** A temporary auth directory with an account for each of `names`, added in that order. */
const seeded = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();

    for (const [index, name] of names.entries()) {
      yield* seedAccount(dir, name, { createdAt: `2026-01-0${index + 1}T00:00:00.000Z` });
    }

    return dir;
  });

/** A pool over the accounts in `dir`, whose token store fails every refresh of "a" with `error`. */
const poolFailingRefreshOfA = (
  dir: string,
  error: Effect.Error<ReturnType<AccountTokens["Service"]["fresh"]>>,
) => {
  const refresh = (refreshing: Account) =>
    refreshing.id === "a" ? Effect.fail(error) : Effect.succeed(refreshing);

  const tokens = Layer.succeed(AccountTokens, {
    fresh: refresh,
    refreshRejected: (id: string) => refresh({ ...account, id }),
  });

  return AccountPool.layer.pipe(Layer.provide([tokens, AccountStore.layer(dir), PoolStates.layer]));
};

/**
 * The id of the account the pool chooses among `names` while every refresh of
 * "a" fails with `error`, and how long until one stops cooling down then.
 */
const chooseWhileRefreshOfAFails = (
  error: Effect.Error<ReturnType<AccountTokens["Service"]["fresh"]>>,
  names: ReadonlyArray<string> = ["a", "b"],
) =>
  Effect.gen(function* () {
    const dir = yield* seeded(names);

    return yield* Effect.gen(function* () {
      const pool = yield* AccountPool;
      const chosen = yield* pool.next(() => true, Option.none());

      return {
        chosen: Option.map(chosen, ({ id }) => id),
        wait: yield* pool.waitFor(() => true),
      };
    }).pipe(Effect.provide(poolFailingRefreshOfA(dir, error)));
  });

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

  it.effect.each([
    new FileLockTimeoutError({ path: "/auth/a.json" }),
    new CorruptFileError({ path: "/auth/a.json", reason: "not JSON" }),
    PlatformError.badArgument({
      module: "FileSystem",
      method: "readFileString",
      description: "/auth/a.json is unreadable",
    }),
  ])("rests an account for a minute when its refresh fails with $_tag, and moves on", (error) =>
    Effect.gen(function* () {
      const logs = collectLogs();

      const { chosen, wait } = yield* chooseWhileRefreshOfAFails(error).pipe(
        Effect.provide(Logger.layer([logs.logger])),
      );

      expect(chosen).toEqual(Option.some("b"));
      expect(wait).toEqual(Option.some(60_000));
      expect(yield* logs.logged("a is cooling down")).toMatchObject({ level: "Warn" });
    }),
  );

  it.effect("skips an account removed while its token was refreshed, without a cooldown", () =>
    Effect.gen(function* () {
      const logs = collectLogs();

      const { chosen, wait } = yield* chooseWhileRefreshOfAFails(
        new AccountNotFoundError({ query: "a" }),
      ).pipe(Effect.provide(Logger.layer([logs.logger])));

      expect(chosen).toEqual(Option.some("b"));
      expect(wait).toEqual(Option.none());
      expect(yield* logs.logged("Skipping a")).toMatchObject({ level: "Warn" });
    }),
  );

  it.effect("finds no account when the only one keeps vanishing on refresh", () =>
    Effect.gen(function* () {
      const { chosen } = yield* chooseWhileRefreshOfAFails(
        new AccountNotFoundError({ query: "a" }),
        ["a"],
      );

      expect(chosen).toEqual(Option.none());
    }),
  );

  it.effect("sets an account aside when its refresh after a refused token fails", () =>
    Effect.gen(function* () {
      const dir = yield* seeded(["a", "b"]);

      const [refreshed, wait] = yield* Effect.gen(function* () {
        const pool = yield* AccountPool;

        return [
          yield* pool.refreshRejected({ ...account, id: "a" }),
          yield* pool.waitFor(() => true),
        ] as const;
      }).pipe(
        Effect.provide(
          poolFailingRefreshOfA(dir, new FileLockTimeoutError({ path: "/auth/a.json" })),
        ),
      );

      expect(refreshed).toEqual(Option.none());
      expect(wait).toEqual(Option.some(60_000));
    }),
  );
});
