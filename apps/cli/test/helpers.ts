// The black-box harness for the `via` binary, shared with apps/e2e as `@via/cli/testing`.
import { Clock, Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** `VIA_E2E_BIN` runs a compiled binary instead of the source. */
const command = (args: ReadonlyArray<string>) => {
  const bin = process.env["VIA_E2E_BIN"];
  return bin === undefined ? ["bun", source, ...args] : [bin, ...args];
};

export type RunResult = { exitCode: number; stdout: string; stderr: string };

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

/**
 * Runs one `via` command to completion. It runs asynchronously so fake servers
 * in the test process can answer it.
 */
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

/**
 * Starts `via serve` in a subprocess that lives as long as the test's scope, and
 * succeeds with the URL it announces once it listens, and `output`, which
 * waits for a line of its stdout containing `text`.
 */
export const startVia = (
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.sync(() => spawnVia(home, ["serve", ...args], env)),
      (running) => Effect.promise(() => (running.kill(), running.exited)),
    );
    const lines = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let stdout = "";
    const readUntil = (found: () => string | undefined) =>
      Effect.promise(async () => {
        for (;;) {
          const seen = found();
          if (seen !== undefined) return seen;
          const chunk = await lines.read();
          if (chunk.done) return undefined;
          stdout += chunk.value;
        }
      });
    const url = yield* readUntil(() => /Listening on (\S+)/.exec(stdout)?.[1]).pipe(
      Effect.flatMap((listening) =>
        listening === undefined
          ? Effect.promise(() => new Response(proc.stderr).text()).pipe(
              Effect.flatMap((stderr) =>
                Effect.die(new Error(`via serve exited before listening:\n${stderr}`)),
              ),
            )
          : Effect.succeed(listening),
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
    return { url, output };
  });

/** `startVia`, for a test that needs only the URL. */
export const serveVia = (
  home: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) => Effect.map(startVia(home, args, env), ({ url }) => url);
