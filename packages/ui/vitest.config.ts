import { defineConfig } from "vitest/config";
import { stylexPlugin } from "./stylex-plugin.ts";

// Components call `stylex.create`, which only works once compiled, so tests
// run the same unplugin transform the app build uses.
const plugin = stylexPlugin();

export default defineConfig({
  // The plugin's dev-server hook polls on an interval that it clears only when
  // an HTTP server closes. Vitest runs without one, so the timer would hold
  // the run open for vitest's 10 s close timeout. Tests need only the
  // transform.
  plugins: [{ ...plugin, configureServer: undefined }],
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
    // A file that starts on modules of its own starts cold: its first test
    // runs React, Base UI and happy-dom's code for the first time, and takes
    // three times the CPU of the next, which under load ran past its time.
    // The files share a worker's modules instead, so only a worker's first
    // test starts cold. Each file still gets a page of its own, and nothing
    // in the components keeps state at module level.
    isolate: false,
  },
});
