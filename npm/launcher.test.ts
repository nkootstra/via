import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schedule } from "effect";
import { BunFileSystem } from "@effect/platform-bun";

const here = import.meta.dirname;

// `bun run` puts a `node` that is really Bun first on PATH; users run the real Node.
const PATH = (process.env.PATH ?? "")
  .split(":")
  .filter((entry) => !entry.includes("bun-node"))
  .join(":");

// A stand-in for via that says it started, then notes the SIGTERM it gets and exits.
const fakeVia = `#!/bin/sh
trap 'echo terminated > "$(dirname "$0")/../got-term"; exit 0' TERM
echo $$ > "$(dirname "$0")/../pid" && mv "$(dirname "$0")/../pid" "$(dirname "$0")/../started"
while true; do sleep 0.05; done
`;

// A service manager stops `via serve` by signalling the process it started: the launcher.
// Live: the waits are for real processes.
it.live(
  "the launcher passes a SIGTERM on to via, so stopping it stops via",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const pkg = `${dir}/node_modules/@nkootstra/via-${process.platform}-${process.arch}`;
      yield* fs.makeDirectory(`${pkg}/bin`, { recursive: true });
      yield* fs.writeFileString(`${pkg}/bin/via`, fakeVia, { mode: 0o755 });
      yield* fs.copyFile(`${here}/via/bin/via.js`, `${dir}/via.js`);

      const launcher = Bun.spawn(["node", `${dir}/via.js`], {
        env: { ...process.env, PATH },
        stdio: ["ignore", "ignore", "pipe"],
      });

      yield* fs
        .exists(`${pkg}/started`)
        .pipe(Effect.filterOrFail(Boolean), Effect.retry(Schedule.spaced("50 millis")));

      // A via the launcher left running would outlive the test. Only a real pid: 0 would
      // signal this whole process group.
      const pid = Number(yield* fs.readFileString(`${pkg}/started`));
      expect(pid).toBeGreaterThan(0);
      yield* Effect.addFinalizer(() =>
        Effect.ignore(Effect.try(() => process.kill(pid, "SIGKILL"))),
      );

      launcher.kill("SIGTERM");
      yield* Effect.promise(() => launcher.exited);

      // Up to ten seconds for via to note the signal, which a loaded CI machine may need.
      const gotTerm = yield* fs.exists(`${pkg}/got-term`).pipe(
        Effect.filterOrFail(Boolean),
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
        Effect.orElseSucceed(() => false),
      );

      const stderr = yield* Effect.promise(() => new Response(launcher.stderr).text());

      expect(
        gotTerm,
        `launcher exited ${launcher.exitCode} ${launcher.signalCode}: ${stderr}`,
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  30_000,
);
