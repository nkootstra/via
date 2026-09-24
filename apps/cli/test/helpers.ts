import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export type RunResult = { exitCode: number; stdout: string; stderr: string };

/** A fresh, scoped `VIA_HOME` for one test. */
export const tempHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
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
    const proc = Bun.spawn(["bun", entry, ...args], {
      env: { ...process.env, ...env, VIA_HOME: home, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  });
