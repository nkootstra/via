import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type Account, AccountStore, AccountTokens, CodexAuth } from "@via/codex-auth";
import { PoolStates } from "@via/pool";
import { Effect, FileSystem, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { AccountPool } from "./account-pool.ts";
import { ok, withVia } from "./testing/harness.ts";

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
  it.effect(
    "moves on to the next account when a request finds the first one's refresh rejected",
    () =>
      withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            // Only now is "a" close enough to expiring to be refreshed: as via started, it
            // still had seven minutes, so asking Codex for the models needed no refresh.
            yield* TestClock.adjust("3 minutes");

            // No model, so via doesn't ask the model catalog which accounts may serve it:
            // asking Codex for the catalog again would refresh "a" before the request did.
            const response = yield* via.post("/v1/responses", { input: "hi" });

            expect(response.status).toBe(200);
            expect(yield* via.logged("a@example.com is locked out")).toMatchObject({
              level: "Warn",
            });
            expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
              served_by: "b@example.com",
            });
          }),
        {
          refreshResponse: { status: 400, body: { error: "invalid_grant" } },
          aExpiresAt: 7 * 60 * 1000,
        },
      ),
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
