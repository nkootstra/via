import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { BunFileSystem } from "@effect/platform-bun";

const here = import.meta.dirname;

const root = `${here}/..`;

// Every package.json whose version reaches users: the CLI's, which `via --version`
// prints, and the npm packages'.
const STAMPED = [
  "apps/cli/package.json",
  "npm/via/package.json",
  "npm/via-darwin-arm64/package.json",
  "npm/via-darwin-x64/package.json",
  "npm/via-linux-arm64/package.json",
  "npm/via-linux-x64/package.json",
];

/** A copy of the stamped files in a temporary directory, and what `set-version.ts` did to it. */
const stamp = (version: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();

    for (const file of STAMPED) {
      yield* fs.makeDirectory(`${dir}/${file.slice(0, file.lastIndexOf("/"))}`, {
        recursive: true,
      });
      yield* fs.copyFile(`${root}/${file}`, `${dir}/${file}`);
    }

    const proc = Bun.spawnSync(["bun", `${here}/set-version.ts`, version, dir], { stderr: "pipe" });

    const read = (file: string) =>
      fs.readFileString(`${dir}/${file}`).pipe(Effect.map((text) => JSON.parse(text)));

    return { exitCode: proc.exitCode, stderr: proc.stderr.toString(), read };
  }).pipe(Effect.provide(BunFileSystem.layer));

it.effect("stamps the version on every package users get, and the launcher's binaries", () =>
  Effect.gen(function* () {
    const { exitCode, read } = yield* stamp("1.2.3");
    expect(exitCode).toBe(0);

    for (const file of STAMPED) expect((yield* read(file)).version).toBe("1.2.3");
    expect((yield* read("npm/via/package.json")).optionalDependencies).toEqual({
      "via-darwin-arm64": "1.2.3",
      "via-darwin-x64": "1.2.3",
      "via-linux-arm64": "1.2.3",
      "via-linux-x64": "1.2.3",
    });
    expect((yield* read("apps/cli/package.json")).name).toBe("@via/cli");
  }),
);

it.effect("refuses a version that isn't X.Y.Z", () =>
  Effect.gen(function* () {
    const { exitCode, stderr, read } = yield* stamp("v1.2");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("v1.2");
    expect((yield* read("apps/cli/package.json")).version).toBe("0.0.0");
  }),
);

it.effect("takes a pre-release version, as CI's and local builds use", () =>
  Effect.gen(function* () {
    const { exitCode, read } = yield* stamp("0.0.0-ci");
    expect(exitCode).toBe(0);
    expect((yield* read("apps/cli/package.json")).version).toBe("0.0.0-ci");
  }),
);
