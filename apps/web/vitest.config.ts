import { stylexPlugin } from "@via/ui/stylex-plugin";
import { themePlugin } from "@via/ui/theme-plugin";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { viaVersion } from "./via-version.ts";

// Screens call `stylex.create`, which only works once compiled, so tests run
// the same unplugin transform the app build uses.
const plugin = stylexPlugin();

export default defineConfig({
  // The plugin's dev-server hook polls on an interval that it clears only when
  // an HTTP server closes, which vitest never opens; tests need the transform.
  plugins: [{ ...plugin, configureServer: undefined }, themePlugin(), viteReact()],
  define: viaVersion,
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
    // A test's waits may each take up to the setup's asyncUtilTimeout, 5 s,
    // which vitest's default for the whole test, also 5 s, can't fit: a wait
    // that ran out would fail as the test timing out, not with Testing
    // Library's account of the page. Twice that fits one full wait and the
    // rest of the test.
    testTimeout: 10_000,
  },
});
