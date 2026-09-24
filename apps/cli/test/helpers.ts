import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export type RunResult = { exitCode: number; stdout: string; stderr: string };

/** A fresh, scoped `VIA_HOME` for one test. */
export const tempHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped();
});

/** Runs the real `via` entrypoint in a subprocess, black-box style. */
export const runVia = (home: string, ...args: ReadonlyArray<string>) =>
  Effect.sync((): RunResult => {
    const proc = Bun.spawnSync(["bun", entry, ...args], {
      env: { ...process.env, VIA_HOME: home, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  });
