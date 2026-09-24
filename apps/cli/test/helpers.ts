import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export type RunResult = { exitCode: number; stdout: string; stderr: string };

/** A fresh, scoped `VIA_HOME` for one test. */
export const tempHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

const spawnVia = (home: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
  Bun.spawn(["bun", entry, ...args], {
    env: { ...process.env, ...env, VIA_HOME: home, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
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
    });
  });

/**
 * Runs the real `via` entrypoint in a subprocess, black-box style. It runs
 * asynchronously so fake servers in the test process can answer it.
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
