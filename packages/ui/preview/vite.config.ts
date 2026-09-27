import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { stylexPlugin } from "../stylex-plugin.ts";

// The component gallery: `bun run --filter @via/ui preview`. It builds with
// the same StyleX unplugin configuration as the tests and the app.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [stylexPlugin()],
  server: { port: 5174, strictPort: true },
});
