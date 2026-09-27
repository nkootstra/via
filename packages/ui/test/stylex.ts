import { fileURLToPath } from "node:url";
import stylex from "@stylexjs/unplugin";

/**
 * The StyleX unplugin as the app build configures it. `dev: false` keeps it
 * on the extraction path: class names in the markup and every rule in a CSS
 * file, with no runtime <style> injection (the admin UI's CSP is
 * `style-src 'self'`). Resolving modules against the repo root makes a
 * `defineVars` hash the same whichever package imports the tokens.
 */
export const stylexPlugin = () =>
  stylex.vite({
    dev: false,
    unstable_moduleResolution: {
      type: "commonJS",
      rootDir: fileURLToPath(new URL("../../..", import.meta.url)),
    },
  });
