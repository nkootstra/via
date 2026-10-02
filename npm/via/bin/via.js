#!/usr/bin/env node
// Runs the prebuilt via binary from the platform package npm installed alongside.
const { spawnSync } = require("node:child_process");

const platform = `@nkootstra/via-${process.platform}-${process.arch}`;

let binary;

try {
  binary = require.resolve(`${platform}/bin/via`);
} catch {
  console.error(`via: no prebuilt binary for ${process.platform}-${process.arch} (${platform})`);
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`via: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) process.kill(process.pid, result.signal);

process.exit(result.status ?? 1);
