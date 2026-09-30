// Compiles the via binary into each platform package: `bun build.ts` for all of
// them, `bun build.ts --host` for this machine's only. A build script's main, like the CLI's.
// Each package's os and arch, and the Bun target that builds it. x64 builds use
// Bun's baseline target, which runs on CPUs without AVX2 (older Intel Macs and
// servers); the default x64 target crashes on them with SIGILL.
const TARGETS = [
  ["darwin", "arm64", "bun-darwin-arm64"],
  ["darwin", "x64", "bun-darwin-x64-baseline"],
  ["linux", "arm64", "bun-linux-arm64"],
  ["linux", "x64", "bun-linux-x64-baseline"],
] as const;

const here = import.meta.dirname;

const entry = `${here}/../apps/cli/src/index.ts`;

const hostOnly = process.argv.includes("--host");

// The binary embeds the admin UI's build; `bun run build` builds it first.
if (!(await Bun.file(`${here}/../apps/web/dist/embedded.ts`).exists())) {
  console.error("build: no admin UI build to embed; run `bun run --cwd apps/web build` first");
  process.exit(1);
}

for (const [os, arch, target] of TARGETS) {
  if (hostOnly && (os !== process.platform || arch !== process.arch)) continue;
  const outfile = `${here}/via-${os}-${arch}/bin/via`;
  await Bun.$`bun build ${entry} --compile --minify --target=${target} --outfile ${outfile}`.quiet();
  console.log(`built ${outfile}`);
}
