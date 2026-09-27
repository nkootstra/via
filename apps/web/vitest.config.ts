import { stylexPlugin } from "@via/ui/stylex-plugin";
import { themePlugin } from "@via/ui/theme-plugin";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Screens call `stylex.create`, which only works once compiled, so tests run
// the same unplugin transform the app build uses.
const plugin = stylexPlugin();

export default defineConfig({
  // The plugin's dev-server hook polls on an interval that it clears only when
  // an HTTP server closes, which vitest never opens; tests need the transform.
  plugins: [{ ...plugin, configureServer: undefined }, themePlugin(), viteReact()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
  },
});
