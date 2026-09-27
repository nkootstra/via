// Compiles the via binary into each platform package: `bun build.ts` for all of
// them, `bun build.ts --host` for this machine's only. A build script's main, like the CLI's.
const TARGETS = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
] as const;

const here = import.meta.dirname;

const entry = `${here}/../apps/cli/src/index.ts`;

const hostOnly = process.argv.includes("--host");

for (const [os, arch] of TARGETS) {
  if (hostOnly && (os !== process.platform || arch !== process.arch)) continue;
  const outfile = `${here}/via-${os}-${arch}/bin/via`;
  await Bun.$`bun build ${entry} --compile --minify --target=bun-${os}-${arch} --outfile ${outfile}`.quiet();
  console.log(`built ${outfile}`);
}
