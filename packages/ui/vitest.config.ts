import { defineConfig } from "vitest/config";
import { stylexPlugin } from "./test/stylex.ts";

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
  },
});
