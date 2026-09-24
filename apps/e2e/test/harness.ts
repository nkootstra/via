import { LLMock } from "@copilotkit/aimock";
import { type FakeIssuerOptions, fakeIssuer, jwt } from "@via/codex-auth/testing";
import { Effect, FileSystem, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import OpenAI from "openai";
import { fileURLToPath } from "node:url";

// A path to spawn, not an import: the suite only sees via from the outside.
const source = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));

/** `VIA_E2E_BIN` runs the suite against a compiled binary instead of the source. */
const command = (args: ReadonlyArray<string>) => {
  const bin = process.env["VIA_E2E_BIN"];
  return bin === undefined ? ["bun", source, ...args] : [bin, ...args];
};

export type RunResult = { exitCode: number; stdout: string; stderr: string };

/** A fresh, scoped `VIA_HOME` for one test. */
export const tempHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

/** A port nothing listens on right now. */
export const freePort = Effect.sync(() => {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
});

const spawnVia = (home: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
  Bun.spawn(command(args), {
    env: { ...process.env, ...env, VIA_HOME: home, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

/** Runs one `via` command to completion. */
export const runVia = (
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.promise(async (): Promise<RunResult> => {
    const proc = spawnVia(home, args, env);
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  });

/** Starts `via serve` for the scope's lifetime and succeeds with its URL. */
export const serveVia = (
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.sync(() => spawnVia(home, ["serve", ...args], env)),
      (running) => Effect.promise(() => (running.kill(), running.exited)),
    );
    return yield* Effect.promise(async () => {
      let stdout = "";
      for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
        stdout += chunk;
        const url = /Listening on (\S+)/.exec(stdout)?.[1];
        if (url !== undefined) return url;
      }
      throw new Error(
        `via serve exited before listening:\n${await new Response(proc.stderr).text()}`,
      );
    });
  });

/** What via actually sent upstream, before aimock redacts or converts it. */
export type UpstreamRequest = {
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

export type Upstream = {
  /** Where via should send Codex traffic. */
  url: string;
  mock: LLMock;
  requests: ReadonlyArray<UpstreamRequest>;
};

/**
 * aimock standing in for the Codex backend, behind a pass-through recorder:
 * aimock's journal redacts `authorization` and converts Responses bodies, and
 * the tests need both raw. Everything is stopped with the scope.
 */
export const startAimock = Effect.gen(function* () {
  const mock = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const server = new LLMock({ port: 0, logLevel: "silent", strict: true });
      await server.start();
      return server;
    }),
    (server) => Effect.promise(() => server.stop()),
  );
  const requests: Array<UpstreamRequest> = [];
  const recorder = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        fetch: async (request) => {
          const { pathname, search } = new URL(request.url);
          const text = await request.text();
          requests.push({
            path: pathname,
            headers: Object.fromEntries(request.headers),
            body: text === "" ? undefined : JSON.parse(text),
          });
          const headers = new Headers(request.headers);
          headers.delete("host");
          const response = await fetch(`${mock.url}${pathname}${search}`, {
            method: request.method,
            headers,
            ...(text !== "" && { body: text }),
          });
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  );
  return { url: `http://127.0.0.1:${recorder.port}`, mock, requests } satisfies Upstream;
});

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
    const url = yield* serveVia(home, ["--port", String(yield* freePort)], env);
    return yield* body({ home, url, key, env });
  });

/** The official SDK, pointed at via. */
export const openai = (via: Via) =>
  new OpenAI({ baseURL: `${via.url}/v1`, apiKey: via.key, maxRetries: 0 });
