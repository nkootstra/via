import { createKey, type SeededAccount, seedAccounts, serveVia, viaHome } from "@via/cli/testing";
import type { FakeIssuerOptions } from "@via/codex-auth/testing";
import { type FakeCodex, startFakeCodex } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import OpenAI from "openai";

export { freePort, realTime, runVia, startIssuer, tempHome } from "@via/cli/testing";

/** The fake Codex backend, scoped; point via at `codex.url`. */
export const startCodex = startFakeCodex;

export type Codex = FakeCodex;

export type Via = {
  home: string;
  url: string;
  key: string;
  env: Record<string, string>;
};

/**
 * Starts a `via serve` with one API key, for as long as the test's scope,
 * sending upstream traffic to `upstream`. Its pool is one account logged in
 * through the fake issuer (`dev@example.com`, `acc-123`), or `accounts` when given.
 */
export const launchVia = (options: {
  upstream: string;
  /** Seed these accounts instead of logging one in through the fake issuer. */
  accounts?: ReadonlyArray<SeededAccount>;
  issuer?: FakeIssuerOptions;
}) =>
  Effect.gen(function* () {
    const { home, env, via } = yield* viaHome(options);

    if (options.accounts === undefined) yield* via("accounts", "add");
    else yield* seedAccounts(home, options.accounts);
    const key = yield* createKey(home, "e2e");
    // Port 0 lets the OS pick a free port; via reports the one it got.
    const url = yield* serveVia(home, ["--port", "0"], env);

    return { home, url, key, env } satisfies Via;
  });

/** The official SDK, pointed at via. */
export const openai = (via: Via) =>
  new OpenAI({ baseURL: `${via.url}/v1`, apiKey: via.key, maxRetries: 0 });
