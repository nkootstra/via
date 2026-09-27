import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import type { FakeIssuerOptions } from "@via/codex-auth/testing";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { type FakeProvider, startFakeProvider } from "@via/providers/testing";
import { Effect } from "effect";
import { freePort, seedAccounts, viaHome, writeConfig } from "./helpers.ts";

/**
 * A home with its own fake Codex backend, whose account logs in through a fake
 * issuer. Times print in UTC.
 */
const setup = (options: { issuer?: FakeIssuerOptions; env?: Record<string, string> } = {}) =>
  Effect.gen(function* () {
    const codex = yield* startFakeCodex;

    const home = yield* viaHome({
      ...options,
      upstream: codex.url,
      env: { TZ: "UTC", ...options.env },
    });

    return { ...home, codex };
  });

/** Configures OpenCode Go in `home`'s config.yaml, served by `provider`, keyed by GO_KEY. */
const configureOpenCodeGo = (home: string, provider: FakeProvider) =>
  writeConfig(
    home,
    `providers:\n  opencode-go:\n    baseUrl: ${provider.url}\n    apiKeyEnv: GO_KEY\n`,
  );

layer(BunFileSystem.layer)("via accounts", (it) => {
  it.effect("add shows the device code, then saves the approved account", () =>
    Effect.gen(function* () {
      const { via } = yield* setup();
      const added = yield* via("accounts", "add");
      expect(added.exitCode).toBe(0);
      expect(added.stdout).toContain("ABCD-1234");
      expect(added.stdout).toContain("/codex/device");
      expect(added.stdout).toContain("dev@example.com");
      expect((yield* via("accounts", "list")).stdout).toMatch(
        /dev@example\.com\s+dev@example\.com\s+pro\s+enabled/,
      );
    }),
  );

  it.effect("add fails with one line when it cannot reach the issuer", () =>
    Effect.gen(function* () {
      const { via } = yield* setup({
        env: { VIA_CODEX_ISSUER: `http://127.0.0.1:${yield* freePort}` },
      });

      const added = yield* via("accounts", "add");
      expect(added.exitCode).toBe(1);
      expect(added.stderr).toMatch(/^error: OpenAI auth request failed/);
      expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
    }),
  );

  it.effect("list explains how to add an account when there is none", () =>
    Effect.gen(function* () {
      const { via } = yield* setup();
      expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
    }),
  );

  it.effect("label, disable and enable change what list shows", () =>
    Effect.gen(function* () {
      const { via } = yield* setup();
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
  );

  it.effect("remove deletes the account", () =>
    Effect.gen(function* () {
      const { via } = yield* setup();
      yield* via("accounts", "add");
      expect((yield* via("accounts", "remove", "dev@example.com")).exitCode).toBe(0);
      expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
    }),
  );

  for (const args of [["remove"], ["enable"], ["disable"], ["label", "x"]]) {
    it.effect(`${args[0]} fails with a message for an unknown account`, () =>
      Effect.gen(function* () {
        const { via } = yield* setup();
        const [command = "", ...rest] = args;
        const result = yield* via("accounts", command, "nobody", ...rest);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe('error: No account with id, label or email "nobody"\n');
      }),
    );
  }

  it.effect("status shows how much of each rate limit window every account has used", () =>
    Effect.gen(function* () {
      const { via } = yield* setup();
      yield* via("accounts", "add");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/dev@example\.com\s+dev@example\.com\s+pro\s+enabled/);
      expect(status.stdout).toMatch(/5h\s+12% used\s+resets 2023-11-14 23:13/);
      expect(status.stdout).toMatch(/7d\s+40% used\s+resets 2023-11-15 22:13/);
    }),
  );

  it.effect("status explains how to add an account when there is none", () =>
    Effect.gen(function* () {
      const { via } = yield* setup();
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("via accounts add");
    }),
  );

  it.effect("status says when an account's usage is unavailable", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* setup();
      // The account the fake issuer signs in.
      codex.usage("acc-123", {}, 403);
      yield* via("accounts", "add");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("ChatGPT did not report usage (HTTP 403)");
    }),
  );

  it.effect("status still lists every account when ChatGPT can't be reached", () =>
    Effect.gen(function* () {
      const { via, home } = yield* viaHome({
        upstream: `http://127.0.0.1:${yield* freePort}`,
        env: { TZ: "UTC" },
      });

      yield* seedAccounts(home, [{ name: "a" }, { name: "b" }]);
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/a\s+a@example\.com\s+pro\s+enabled/);
      expect(status.stdout).toMatch(/b\s+b@example\.com\s+pro\s+enabled/);
      expect(status.stdout).toContain("Could not reach ChatGPT for usage");
    }),
  );

  it.effect("status says when ChatGPT's usage answer can't be read", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* setup();
      codex.usage("acc-123", { rate_limit: "nope" });
      yield* via("accounts", "add");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("ChatGPT's usage answer could not be read");
    }),
  );

  it.effect(
    "status prints the account line and exits 0 when refresh hits an auth-server hiccup",
    () =>
      Effect.gen(function* () {
        const { via, home } = yield* setup({
          issuer: { refreshResponse: { status: 500, body: {} } },
        });

        yield* seedAccounts(home, [{ name: "dev", expiresAt: 0 }]);
        const status = yield* via("accounts", "status");
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toMatch(/dev\s+dev@example\.com\s+pro\s+enabled/);
        expect(status.stdout).toContain("OpenAI auth request failed");
      }),
  );

  it.effect("status says to log in again when the issuer rejects an account's refresh token", () =>
    Effect.gen(function* () {
      const { via, home } = yield* setup({
        issuer: { refreshResponse: { status: 401, body: { error: "invalid_grant" } } },
      });

      yield* seedAccounts(home, [{ name: "dev", expiresAt: 0 }]);
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/dev\s+dev@example\.com\s+pro\s+enabled/);
      expect(status.stdout).toContain(
        "The refresh token was rejected (invalid_grant); log in to this account again",
      );
    }),
  );

  it.effect("status refuses an invalid config.yaml", () =>
    Effect.gen(function* () {
      const { via, home } = yield* setup();
      yield* writeConfig(home, "port: nope\n");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(1);
      expect(status.stderr).toMatch(/^error: Invalid config/);
    }),
  );

  it.effect("status shows each provider like an account, its windows lined up with theirs", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      provider.usage({
        usage: {
          rolling: { status: "ok", percent: 0, resetsAt: "2026-09-26T23:40:07.697Z" },
          weekly: { status: "ok", percent: 26, resetsAt: "2026-09-28T00:00:00.000Z" },
        },
      });
      const { via, home } = yield* setup({ env: { GO_KEY: "sk-go" } });
      yield* configureOpenCodeGo(home, provider);
      yield* via("accounts", "add");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/5h\s+12% used/);
      expect(status.stdout).toMatch(/^opencode-go {2}provider {2}available$/m);
      expect(status.stdout).toMatch(/rolling\s+0% used\s+resets 2026-09-26 23:40/);
      expect(status.stdout).toMatch(/weekly\s+26% used\s+resets 2026-09-28 00:00/);

      const columns = status.stdout
        .split("\n")
        .filter((line) => line.includes("% used"))
        .map((line) => line.indexOf("% used"));

      expect(columns).toHaveLength(4);
      expect(new Set(columns).size).toBe(1);
    }),
  );

  it.effect("status shows a provider with a used-up window as exhausted until it resets", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      provider.usage({
        usage: {
          rolling: { status: "ok", percent: 30, resetsAt: "2099-01-01T05:00:00.000Z" },
          weekly: { status: "rate-limited", percent: 100, resetsAt: "2099-01-04T00:00:00.000Z" },
        },
      });
      const { via, home } = yield* setup({ env: { GO_KEY: "sk-go" } });
      yield* configureOpenCodeGo(home, provider);
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(
        /^opencode-go {2}provider {2}exhausted until 2099-01-04 00:00 \(weekly\)$/m,
      );
      expect(status.stdout).toMatch(/weekly\s+100% used\s+resets 2099-01-04 00:00/);
    }),
  );

  it.effect("status shows a provider that reports no usage as available", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      const { via, home } = yield* setup({ env: { LOCAL_KEY: "sk-local" } });
      yield* writeConfig(
        home,
        `providers:\n  local:\n    baseUrl: ${provider.url}\n    apiKeyEnv: LOCAL_KEY\n`,
      );
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/^local {2}provider {2}available$/m);
    }),
  );

  it.effect("status says when a provider's usage is unavailable", () =>
    Effect.gen(function* () {
      // The fake answers its usage endpoint with a 500 until told otherwise.
      const provider = yield* startFakeProvider;
      const { via, home } = yield* setup({ env: { GO_KEY: "sk-go" } });
      yield* configureOpenCodeGo(home, provider);
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(
        /^opencode-go {2}provider {2}unavailable: opencode-go did not report usage \(HTTP 500\)$/m,
      );
    }),
  );

  it.effect("status says when a provider's API key is not set", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      const { via, home } = yield* setup();
      yield* configureOpenCodeGo(home, provider);
      yield* via("accounts", "add");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/5h\s+12% used/);
      expect(status.stdout).toContain("reads its API key from GO_KEY, which is not set");
    }),
  );

  it.effect("status says when a provider is not built in and has no baseUrl", () =>
    Effect.gen(function* () {
      const { via, home } = yield* setup({ env: { LOCAL_KEY: "sk-local" } });
      yield* writeConfig(home, "providers:\n  local:\n    apiKeyEnv: LOCAL_KEY\n");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain('Provider "local" is not built in, so it needs a baseUrl');
    }),
  );
});
