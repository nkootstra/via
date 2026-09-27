import type { Plugin } from "vite";
import { themeStylesheet } from "./src/palette.ts";
import { themeScript } from "./src/theme-script.ts";

const id = "virtual:via-theme.css";

/**
 * The theme, before the first paint. It serves the palette stylesheet as
 * `import "virtual:via-theme.css"`, built from the same scheme constants the
 * components are designed against, for the app to bundle into its linked
 * stylesheet. And it inlines `themeScript` at the top of an `index.html`'s
 * head, so a stored choice applies before anything paints; a page rendered
 * another way inlines the script itself.
 */
export const themePlugin = (): Plugin => ({
  name: "via-theme",
  resolveId: (source) => (source === id ? id : null),
  load: (loaded) => (loaded === id ? themeStylesheet() : null),
  transformIndexHtml: () => [{ tag: "script", children: themeScript, injectTo: "head-prepend" }],
});
