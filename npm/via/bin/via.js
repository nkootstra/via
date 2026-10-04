#!/usr/bin/env node
// Runs the prebuilt via binary from the platform package npm installed alongside.
const { spawn } = require("node:child_process");

const platform = `@nkootstra/via-${process.platform}-${process.arch}`;

let binary;

try {
  binary = require.resolve(`${platform}/bin/via`);
} catch {
  console.error(`via: no prebuilt binary for ${process.platform}-${process.arch} (${platform})`);
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

// A service manager stops via by signalling this process, so via has to hear it too. Ctrl-C
// already reaches via through the terminal; passing SIGINT on as well does no harm.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`via: ${error.message}`);
  process.exit(1);
});

child.on("exit", (status, signal) => {
  if (signal) {
    // Ends this process the way via ended, now the handler above no longer stands in the way.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }

  process.exit(status ?? 1);
});
