import { fileURLToPath } from "node:url";
import stylex from "@stylexjs/unplugin";

/**
 * The StyleX unplugin as the app build configures it. `dev: false` keeps it
 * on the extraction path: class names in the markup and every rule in a CSS
 * file, with no runtime <style> injection (the admin UI's CSP is
 * `style-src 'self'`). Resolving modules against the repo root makes a
 * `defineVars` hash the same whichever package imports the tokens.
 *
 * `enableMediaQueryOrder` rewrites a property's several media queries so the
 * last one wins. No style here gives a property more than one, so it changes
 * nothing in the CSS, but in 0.19.1 it now and then fails a Linux build with
 * "Invalid media query syntax" against a file whose queries are fine.
 */
export const stylexPlugin = () =>
  stylex.vite({
    dev: false,
    enableMediaQueryOrder: false,
    unstable_moduleResolution: {
      type: "commonJS",
      rootDir: fileURLToPath(new URL("../..", import.meta.url)),
    },
  });
