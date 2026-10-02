import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { BunFileSystem } from "@effect/platform-bun";

const here = import.meta.dirname;

const platform = `via-${process.platform}-${process.arch}`;

// `bun run` puts a `node` that is really Bun first on PATH; users run the real Node.
const PATH = (process.env.PATH ?? "")
  .split(":")
  .filter((entry) => !entry.includes("bun-node"))
  .join(":");

/** Runs a command to completion, failing the test with its output if it exits non-zero. */
const run = (cmd: ReadonlyArray<string>, cwd: string) =>
  Effect.sync(() => {
    const proc = Bun.spawnSync([...cmd], {
      cwd,
      env: { ...process.env, PATH },
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = proc.stdout.toString();
    expect(proc.exitCode, `${cmd.join(" ")}\n${stdout}\n${proc.stderr.toString()}`).toBe(0);

    return stdout;
  });

// What users get: `npm install` of the launcher and this platform's binary, run by Node.
it.effect(
  "the packed npm packages install and run via under Node",
  () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      yield* run(["bun", "build.ts", "--host"], here);
      yield* run(["npm", "pack", "--pack-destination", dir, "./via", `./${platform}`], here);
      yield* run(["npm", "init", "-y"], dir);
      yield* run(
        [
          "npm",
          "install",
          "--omit=optional",
          "--no-audit",
          "--no-fund",
          `./nkootstra-${platform}-0.0.0.tgz`,
          "./nkootstra-via-0.0.0.tgz",
        ],
        dir,
      );
      const help = yield* run(["node", "node_modules/.bin/via", "--help"], dir);
      expect(help).toContain("One OpenAI-compatible endpoint");
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  120_000,
);
