import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type FakeIssuerOptions, fakeIssuer, jwt } from "@via/codex-auth/testing";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { Effect, FileSystem, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { runVia, tempHome } from "./helpers.ts";

/**
 * A `via` runner with its own home, logging in against a local fake issuer and
 * reading usage from a fake Codex backend, which refuses with `usageStatus` when given.
 * Times print in UTC.
 */
const withVia = <A, E, R>(
  body: (
    via: (...args: ReadonlyArray<string>) => ReturnType<typeof runVia>,
    home: string,
  ) => Effect.Effect<A, E, R>,
  usageStatus?: number,
  issuerOptions?: FakeIssuerOptions,
) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const codex = yield* startFakeCodex;
    // The account the fake issuer signs in.
    if (usageStatus !== undefined) codex.usage("acc-123", {}, usageStatus);
    const issuer = yield* Layer.build(fakeIssuer(issuerOptions));
    const env = {
      VIA_CODEX_ISSUER: yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(
        Effect.provide(issuer),
      ),
      VIA_CODEX_BASE_URL: codex.url,
      TZ: "UTC",
    };
    return yield* body((...args) => runVia(home, args, env), home);
  });

/** Writes an account straight into `home`'s auth dir, with an already-expired access token. */
const seedExpiredAccount = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${home}/auth`, { recursive: true });
    yield* fs.writeFileString(
      `${home}/auth/dev.json`,
      JSON.stringify({
        id: "dev",
        label: "dev",
        email: "dev@example.com",
        plan: "pro",
        accountId: "acc-123",
        accessToken: "at-dev",
        refreshToken: "rt-1",
        idToken: jwt({
          email: "dev@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc-123",
            chatgpt_plan_type: "pro",
          },
        }),
        expiresAt: 0,
        enabled: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
    );
  });

layer(BunFileSystem.layer)("via accounts", (it) => {
  it.effect("add shows the device code, then saves the approved account", () =>
    withVia((via) =>
      Effect.gen(function* () {
        const added = yield* via("accounts", "add");
        expect(added.exitCode).toBe(0);
        expect(added.stdout).toContain("ABCD-1234");
        expect(added.stdout).toContain("/codex/device");
        expect(added.stdout).toContain("dev@example.com");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /dev@example\.com\s+dev@example\.com\s+pro\s+enabled/,
        );
      }),
    ),
  );

  it.effect("list explains how to add an account when there is none", () =>
    withVia((via) =>
      Effect.gen(function* () {
        expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
      }),
    ),
  );

  it.effect("label, disable and enable change what list shows", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        expect((yield* via("accounts", "label", "dev@example.com", "work")).exitCode).toBe(0);
        yield* via("accounts", "disable", "work");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /work\s+dev@example\.com\s+pro\s+disabled/,
        );
        yield* via("accounts", "enable", "work");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /work\s+dev@example\.com\s+pro\s+enabled/,
        );
      }),
    ),
  );

  it.effect("remove deletes the account", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        expect((yield* via("accounts", "remove", "dev@example.com")).exitCode).toBe(0);
        expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
      }),
    ),
  );

  it.effect("an unknown account fails with a message", () =>
    withVia((via) =>
      Effect.gen(function* () {
        const result = yield* via("accounts", "disable", "nobody");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No account with id, label or email "nobody"');
      }),
    ),
  );

  it.effect("status shows how much of each rate limit window every account has used", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        const status = yield* via("accounts", "status");
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toMatch(/dev@example\.com\s+dev@example\.com\s+pro\s+enabled/);
        expect(status.stdout).toMatch(/5h\s+12% used\s+resets 2023-11-14 23:13/);
        expect(status.stdout).toMatch(/7d\s+40% used\s+resets 2023-11-15 22:13/);
      }),
    ),
  );

  it.effect("status says when an account's usage is unavailable", () =>
    withVia(
      (via) =>
        Effect.gen(function* () {
          yield* via("accounts", "add");
          const status = yield* via("accounts", "status");
          expect(status.exitCode).toBe(0);
          expect(status.stdout).toContain("ChatGPT did not report usage (HTTP 403)");
        }),
      403,
    ),
  );

  it.effect(
    "status prints the account line and exits 0 when refresh hits an auth-server hiccup",
    () =>
      withVia(
        (via, home) =>
          Effect.gen(function* () {
            yield* seedExpiredAccount(home);
            const status = yield* via("accounts", "status");
            expect(status.exitCode).toBe(0);
            expect(status.stdout).toMatch(/dev\s+dev@example\.com\s+pro\s+enabled/);
            expect(status.stdout).toContain("OpenAI auth request failed");
          }),
        undefined,
        { refreshResponse: { status: 500, body: {} } },
      ),
  );
});
