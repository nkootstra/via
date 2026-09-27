// The black-box harness for the `via` binary, shared with apps/e2e as `@via/cli/testing`.
import { type FakeIssuerOptions, seedAccount, startFakeIssuer } from "@via/codex-auth/testing";
import { Clock, Effect, FileSystem, Predicate } from "effect";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** `VIA_E2E_BIN` runs a compiled binary instead of the source. */
const command = (args: ReadonlyArray<string>) => {
  const bin = process.env["VIA_E2E_BIN"];

  return bin === undefined ? ["bun", source, ...args] : [bin, ...args];
};

/**
 * Runs `effect` on the wall clock. Tests get a TestClock, which would never
 * let a timeout on a real process fire.
 */
export const realTime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Clock.Clock, Clock.Clock.defaultValue());

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

/** Everything `stream` carries, as text, once it ends. */
const readAll = (stream: ReadableStream<Uint8Array>) =>
  Effect.promise(() => new Response(stream).text());

/** Kills a running `via` and waits for it to exit. */
const kill = (proc: ReturnType<typeof spawnVia>) =>
  Effect.promise(() => (proc.kill(), proc.exited));

/**
 * Runs one `via` command to completion. It runs asynchronously so fake servers
 * in the test process can answer it.
 */
export const runVia = (
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.suspend(() => {
    const proc = spawnVia(home, args, env);

    return Effect.all(
      {
        exitCode: Effect.promise(() => proc.exited),
        stdout: readAll(proc.stdout),
        stderr: readAll(proc.stderr),
      },
      { concurrency: "unbounded" },
    );
  });

/**
 * Starts `via serve` in a subprocess that lives as long as the test's scope, and
 * succeeds with the URL it announces once it listens; `output`, which waits for
 * a line of its stdout containing `text`; and `stop`, which stops it and
 * succeeds with everything it wrote to stderr.
 */
export const startVia = (
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.sync(() => spawnVia(home, ["serve", ...args], env)),
      kill,
    );

    const stderr = readAll(proc.stderr);

    const lines = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let stdout = "";

    const readUntil = (found: () => string | undefined) =>
      Effect.gen(function* () {
        for (;;) {
          const seen = found();

          if (seen !== undefined) return seen;
          const chunk = yield* Effect.promise(() => lines.read());

          if (chunk.done) return undefined;
          stdout += chunk.value;
        }
      });

    const url = yield* readUntil(() => /Listening on (\S+)/.exec(stdout)?.[1]).pipe(
      Effect.filterOrElse(Predicate.isNotUndefined, () =>
        Effect.flatMap(stderr, (written) =>
          Effect.die(new Error(`via serve exited before listening:\n${written}`)),
        ),
      ),
      // Fail a via that never starts listening here, not at the test timeout.
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.die(new Error("via serve did not start listening in 15 seconds")),
      }),
      realTime,
    );

    const output = (text: string) =>
      // Only whole lines: the last one may still be arriving.
      readUntil(() =>
        stdout
          .split("\n")
          .slice(0, -1)
          .find((line) => line.includes(text)),
      ).pipe(Effect.map((line) => line ?? ""));

    const stop = Effect.andThen(kill(proc), stderr);

    return { url, output, stop };
  });

/** `startVia`, for a test that needs only the URL. */
export const serveVia = (
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) => Effect.map(startVia(home, args, env), ({ url }) => url);

/**
 * A fresh home whose `via` logs in through a fake issuer, answering as
 * `issuer` says, and sends Codex traffic to `upstream`; `env` adds variables.
 * `via(...args)` runs one command in it.
 */
export const viaHome = (options: {
  upstream: string;
  issuer?: FakeIssuerOptions;
  env?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const home = yield* tempHome;

    const env = {
      VIA_CODEX_ISSUER: yield* startFakeIssuer(options.issuer),
      VIA_CODEX_BASE_URL: options.upstream,
      ...options.env,
    };

    return { home, env, via: (...args: ReadonlyArray<string>) => runVia(home, args, env) };
  });

/** Creates an API key called `name` in `home` and succeeds with the key. */
export const createKey = (home: string, name: string) =>
  Effect.map(
    runVia(home, ["keys", "create", "--name", name]),
    ({ stdout }) => stdout.trim().split("\n").at(-1) ?? "",
  );

/** Writes `home`'s config.yaml. */
export const writeConfig = (home: string, yaml: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(`${home}/config.yaml`, yaml);
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
  Effect.forEach(
    accounts,
    ({ name, ...overrides }, index) =>
      seedAccount(`${home}/auth`, name, {
        ...overrides,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    { discard: true },
  );
