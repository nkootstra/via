// Stamps a release's version on every package.json whose version reaches users:
// `bun set-version.ts <X.Y.Z[-pre]> [repo root]`. The release runs it before building,
// so the versions in the repository stay 0.0.0. A build script's main, like build.ts.
const [version, root = `${import.meta.dirname}/..`] = process.argv.slice(2);

if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    `set-version: expected a version like 1.2.3 or 1.2.3-dev, got ${version ?? "nothing"}`,
  );
  process.exit(1);
}

const PLATFORMS = ["via-darwin-arm64", "via-darwin-x64", "via-linux-arm64", "via-linux-x64"];

const stamp = async (file: string, change: (pkg: Record<string, unknown>) => void) => {
  const path = `${root}/${file}`;
  const pkg = await Bun.file(path).json();
  pkg.version = version;
  change(pkg);
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
};

await stamp("apps/cli/package.json", () => {});
for (const platform of PLATFORMS) await stamp(`npm/${platform}/package.json`, () => {});
await stamp("npm/via/package.json", (pkg) => {
  pkg.optionalDependencies = Object.fromEntries(PLATFORMS.map((platform) => [platform, version]));
});
