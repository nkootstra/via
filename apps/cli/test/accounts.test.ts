import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import type { FakeIssuerOptions } from "@via/codex-auth/testing";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { type FakeProvider, startFakeProvider } from "@via/providers/testing";
import { Effect } from "effect";
import { freePort, runVia, seedAccounts, viaHome, writeConfig } from "./helpers.ts";

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

/** Sets OpenCode Go up in `home` as a fake that takes every key, as `add` checks them with it. */
const acceptOpenCodeGoKeys = (home: string) =>
  Effect.gen(function* () {
    const provider = yield* startFakeProvider;
    provider.usage({ usage: {} });
    yield* writeConfig(home, `providers:\n  opencode-go:\n    baseUrl: ${provider.url}\n`);

    return provider;
  });

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

  it.effect("add signs an account that is already in the pool in again, keeping its label", () =>
    Effect.gen(function* () {
      const { via } = yield* setup();
      yield* via("accounts", "add");
      yield* via("accounts", "label", "dev@example.com", "work");
      const again = yield* via("accounts", "add");
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain(
        'Signed "work" in again: dev@example.com (pro) was already in the pool, so it got fresh tokens.\n',
      );
      expect(again.stdout).not.toContain("Added");
      const listed = (yield* via("accounts", "list")).stdout;
      expect(listed).toMatch(/work\s+dev@example\.com\s+pro\s+enabled/);
      expect(listed.match(/dev@example\.com/g)).toHaveLength(1);
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

  it.effect("add --provider opencode-go stores the key it reads from stdin", () =>
    Effect.gen(function* () {
      const { home, env, via } = yield* setup();
      yield* acceptOpenCodeGoKeys(home);

      const added = yield* runVia(
        home,
        ["accounts", "add", "--provider", "opencode-go"],
        env,
        "sk-go-secret-1234\n",
      );

      expect(added.exitCode).toBe(0);
      expect(added.stdout).toBe('Added OpenCode Go key …1234 as "OpenCode Go …1234".\n');
      const listed = yield* via("accounts", "list");
      expect(listed.stdout).toMatch(
        /^\w+ {2}OpenCode Go …1234 {2}opencode-go {2}…1234 {2}enabled$/m,
      );
      expect(listed.stdout).not.toContain("secret");
    }),
  );

  it.effect("add --provider opencode-go refuses an empty key", () =>
    Effect.gen(function* () {
      const { home, env } = yield* setup();
      const added = yield* runVia(home, ["accounts", "add", "--provider", "opencode-go"], env, "");
      expect(added.exitCode).toBe(1);
      expect(added.stderr).toBe("error: No OpenCode Go API key was given\n");
    }),
  );

  it.effect("add --provider opencode-go does not store a key OpenCode Go refuses", () =>
    Effect.gen(function* () {
      const { home, env, via } = yield* setup();
      const provider = yield* acceptOpenCodeGoKeys(home);
      provider.usageFor("sk-go-wrong", { error: "unauthorized" }, 401);

      const added = yield* runVia(
        home,
        ["accounts", "add", "--provider", "opencode-go"],
        env,
        "sk-go-wrong",
      );

      expect(added.exitCode).toBe(1);
      expect(added.stderr).toBe(
        "error: OpenCode Go refused this API key (HTTP 401); check that it is right\n",
      );
      expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
    }),
  );

  it.effect("add --provider opencode-go does not store a key it can't check", () =>
    Effect.gen(function* () {
      const { home, env, via } = yield* setup();
      yield* writeConfig(
        home,
        `providers:\n  opencode-go:\n    baseUrl: http://127.0.0.1:${yield* freePort}\n`,
      );

      const added = yield* runVia(
        home,
        ["accounts", "add", "--provider", "opencode-go"],
        env,
        "sk-go-1234",
      );

      expect(added.exitCode).toBe(1);
      expect(added.stderr).toBe(
        "error: Could not check the key with OpenCode Go: it could not be reached\n",
      );
      expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
    }),
  );

  it.effect("add --provider opencode-go refuses a key it already stores", () =>
    Effect.gen(function* () {
      const { home, env } = yield* setup();
      yield* acceptOpenCodeGoKeys(home);
      const args = ["accounts", "add", "--provider", "opencode-go"];
      yield* runVia(home, args, env, "sk-go-1234");
      const again = yield* runVia(home, args, env, "sk-go-1234");
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toBe(
        'error: That OpenCode Go key is already stored, as "OpenCode Go …1234"\n',
      );
    }),
  );

  it.effect("label, disable, enable and remove an OpenCode Go account", () =>
    Effect.gen(function* () {
      const { home, env, via } = yield* setup();
      yield* acceptOpenCodeGoKeys(home);
      yield* runVia(home, ["accounts", "add", "--provider", "opencode-go"], env, "sk-go-1234");
      expect((yield* via("accounts", "label", "OpenCode Go …1234", "go")).exitCode).toBe(0);
      yield* via("accounts", "disable", "go");
      expect((yield* via("accounts", "list")).stdout).toMatch(
        /go {2}opencode-go {2}…1234 {2}disabled/,
      );
      yield* via("accounts", "enable", "go");
      expect((yield* via("accounts", "list")).stdout).toMatch(
        /go {2}opencode-go {2}…1234 {2}enabled/,
      );
      expect((yield* via("accounts", "remove", "go")).exitCode).toBe(0);
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

  it.effect(
    "status shows each OpenCode Go account like a ChatGPT one, their windows lined up",
    () =>
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
        expect(status.stdout).toMatch(
          /^GO_KEY {2}OpenCode Go \(from GO_KEY\) {2}opencode-go {2}…k-go {2}enabled {2}available$/m,
        );
        expect(status.stdout).not.toContain("sk-go");
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

  it.effect("status shows OpenCode Go's deprecated key variable without storing its key", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      provider.usage({ usage: {} });
      const { via, home } = yield* setup({ env: { GO_KEY: "sk-go" } });
      yield* configureOpenCodeGo(home, provider);
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/^GO_KEY {2}OpenCode Go \(from GO_KEY\) {2}opencode-go /m);
      expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
    }),
  );

  it.effect("status shows OpenCode Go's key variable once when an account has its key", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      provider.usage({ usage: {} });
      const { home, env, via } = yield* setup({ env: { GO_KEY: "sk-go" } });
      yield* configureOpenCodeGo(home, provider);
      yield* runVia(home, ["accounts", "add", "--provider", "opencode-go"], env, "sk-go");
      const status = yield* via("accounts", "status");
      expect(status.stdout.match(/opencode-go {2}…k-go/g)).toHaveLength(1);
      expect(status.stdout).toMatch(/^\w+ {2}OpenCode Go …k-go {2}opencode-go /m);
    }),
  );

  it.effect("status shows an OpenCode Go account with a used-up window as exhausted", () =>
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
        /opencode-go {2}…k-go {2}enabled {2}exhausted until 2099-01-04 00:00 \(weekly\)$/m,
      );
      expect(status.stdout).toMatch(/weekly\s+100% used\s+resets 2099-01-04 00:00/);
    }),
  );

  it.effect("status asks each provider whether it can be used, and says why not", () =>
    Effect.gen(function* () {
      // It lists no models, so it answers 500.
      const down = yield* startFakeProvider;
      const openrouter = yield* startFakeProvider;
      const { via, home } = yield* setup({ env: { OR_KEY: "sk-or-bad" } });
      yield* writeConfig(
        home,
        `providers:\n  local:\n    baseUrl: ${down.url}\n` +
          `  openrouter:\n    baseUrl: ${openrouter.url}\n    apiKeyEnv: OR_KEY\n`,
      );
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/^local {2}provider {2}unavailable: it answered HTTP 500$/m);
      expect(status.stdout).toMatch(/^openrouter {2}provider {2}key refused \(HTTP 401\)$/m);
    }),
  );

  it.effect("status shows a provider that answers as available", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      provider.models(["m"]);
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

  it.effect("status says when an OpenCode Go account's usage is unavailable", () =>
    Effect.gen(function* () {
      // The fake answers its usage endpoint with a 500 until told otherwise.
      const provider = yield* startFakeProvider;
      const { via, home } = yield* setup({ env: { GO_KEY: "sk-go" } });
      yield* configureOpenCodeGo(home, provider);
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(
        /…k-go {2}enabled {2}unavailable: opencode-go did not report usage \(HTTP 500\)$/m,
      );
    }),
  );

  it.effect("status says when a provider's API key is not set", () =>
    Effect.gen(function* () {
      const provider = yield* startFakeProvider;
      const { via, home } = yield* setup();
      yield* writeConfig(
        home,
        `providers:\n  local:\n    baseUrl: ${provider.url}\n    apiKeyEnv: LOCAL_KEY\n`,
      );
      yield* via("accounts", "add");
      const status = yield* via("accounts", "status");
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(/5h\s+12% used/);
      expect(status.stdout).toContain("reads its API key from LOCAL_KEY, which is not set");
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
