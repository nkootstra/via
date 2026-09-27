import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type Account, AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { seedAccount, startFakeIssuer } from "@via/codex-auth/testing";
import { PoolStates } from "@via/pool";
import { Effect, FileSystem, Layer, Logger, Option } from "effect";
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
});
