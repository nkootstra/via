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
 * succeeds with the URL it announces once it listens.
 */
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
    }).pipe(
      // Fail a via that never starts listening here, not at the test timeout.
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.die(new Error("via serve did not start listening in 15 seconds")),
      }),
      realTime,
    );
  });
