import { fileURLToPath } from "node:url";
import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vitest/config";

// Components call `stylex.create`, which only works once compiled, so tests
// run the same unplugin transform the app build uses. `dev: false` keeps it
// on the extraction path: class names in the markup, no runtime <style>
// injection. The module resolution matches apps/web's, so `defineVars`
// hashes agree across packages.
const plugin = stylex.vite({
  dev: false,
  unstable_moduleResolution: {
    type: "commonJS",
    rootDir: fileURLToPath(new URL("../..", import.meta.url)),
  },
});

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
