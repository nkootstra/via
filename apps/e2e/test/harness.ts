import { runVia, serveVia, tempHome } from "@via/cli/testing";
import { type FakeIssuerOptions, fakeIssuer, jwt } from "@via/codex-auth/testing";
import { startFakeCodex } from "@via/codex-upstream/testing";
import { Effect, FileSystem, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import OpenAI from "openai";

export { freePort, realTime, type RunResult, runVia, serveVia, tempHome } from "@via/cli/testing";

/** The fake Codex backend, scoped; point via at `codex.url`. */
export const startCodex = startFakeCodex;

export type Codex = Effect.Success<typeof startFakeCodex>;

/** The fake OpenAI issuer, scoped, as a base URL. */
export const startIssuer = (options: FakeIssuerOptions = {}) =>
  Effect.gen(function* () {
    const issuer = yield* Layer.build(fakeIssuer(options));
    return yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(issuer));
  });

export type SeededAccount = {
  name: string;
  /** Access token expiry in ms; far in the future by default. */
  expiresAt?: number;
  enabled?: boolean;
};

/**
 * Writes accounts straight into `$VIA_HOME/auth`, in order, as `accounts add`
 * would have: account `a` gets id `a`, email `a@example.com`, ChatGPT account
 * `acc-a` and access token `at-a`. The fake issuer only knows one identity, so
 * this is how a test gets a pool of several.
 */
export const seedAccounts = (home: string, accounts: ReadonlyArray<SeededAccount>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${home}/auth`, { recursive: true });
    yield* Effect.forEach(accounts, ({ name, expiresAt = 1e15, enabled = true }, index) =>
      fs.writeFileString(
        `${home}/auth/${name}.json`,
        JSON.stringify({
          id: name,
          label: name,
          email: `${name}@example.com`,
          plan: "pro",
          accountId: `acc-${name}`,
          accessToken: `at-${name}`,
          refreshToken: "rt-1",
          idToken: jwt({
            email: `${name}@example.com`,
            "https://api.openai.com/auth": {
              chatgpt_account_id: `acc-${name}`,
              chatgpt_plan_type: "pro",
            },
          }),
          expiresAt,
          enabled,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        }),
      ),
    );
  });

export type Via = {
  home: string;
  url: string;
  key: string;
  env: Record<string, string>;
};

/**
 * A running `via serve` with one API key, sending upstream traffic to
 * `upstream`. Its pool is one account logged in through the fake issuer
 * (`dev@example.com`, `acc-123`), or `accounts` when given.
 */
export const withVia = <A, E, R>(
  options: {
    upstream: string;
    /** Seed these accounts instead of logging one in through the fake issuer. */
    accounts?: ReadonlyArray<SeededAccount>;
    issuer?: FakeIssuerOptions;
  },
  body: (via: Via) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const env = {
      VIA_CODEX_ISSUER: yield* startIssuer(options.issuer),
      VIA_CODEX_BASE_URL: options.upstream,
    };
    if (options.accounts === undefined) yield* runVia(home, ["accounts", "add"], env);
    else yield* seedAccounts(home, options.accounts);
    const created = yield* runVia(home, ["keys", "create", "--name", "e2e"]);
    const key = created.stdout.trim().split("\n").at(-1) ?? "";
    // Port 0 lets the OS pick a free port; via reports the one it got.
    const url = yield* serveVia(home, ["--port", "0"], env);
    return yield* body({ home, url, key, env });
  });

/** The official SDK, pointed at via. */
export const openai = (via: Via) =>
  new OpenAI({ baseURL: `${via.url}/v1`, apiKey: via.key, maxRetries: 0 });
