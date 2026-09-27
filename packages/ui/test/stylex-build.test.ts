// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stylexPlugin } from "../stylex-plugin.ts";
import { themeScript } from "../src/theme-script.ts";
import { themePlugin } from "../theme-plugin.ts";

const fixture = fileURLToPath(new URL("build-fixture", import.meta.url));

const outDir = mkdtempSync(join(tmpdir(), "via-ui-build-"));

const read = (file: string) => readFileSync(join(outDir, file), "utf8");

const assets = (extension: string) =>
  readdirSync(join(outDir, "assets"))
    .filter((file) => file.endsWith(extension))
    .map((file) => read(join("assets", file)));

// The app's CSP will be `style-src 'self'`, so every StyleX rule has to reach
// the browser as a stylesheet file: nothing inline, nothing injected.
describe("a production build with the StyleX unplugin", () => {
  beforeAll(async () => {
    await build({
      configFile: false,
      root: fixture,
      logLevel: "silent",
      plugins: [stylexPlugin(), themePlugin()],
      build: { outDir, emptyOutDir: true },
    });
  }, 60_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it("extracts the components' styles into the linked stylesheet", () => {
    const html = read("index.html");
    const [css = ""] = assets(".css");

    expect(html).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
    expect(html).not.toContain("<style");
    // A Button fill, and the palette with its dark-mode values.
    expect(css).toContain("color-mix(in oklab");
    expect(css).toMatch(/prefers-color-scheme: ?dark/);
    expect(css).toMatch(/\[data-theme="?dark"?\]\s*\{[^}]*--via-background:/);
  });

  it("inlines the theme script ahead of everything else in the head", () => {
    const html = read("index.html");
    const script = html.indexOf(`<script>${themeScript}</script>`);

    expect(script).toBeGreaterThan(html.indexOf("<head>"));
    expect(script).toBeLessThan(html.indexOf("<link"));
    expect(script).toBeLessThan(html.indexOf('<script type="module"'));
  });

  it("injects no styles at runtime", () => {
    const js = assets(".js").join("\n");

    expect(js).not.toContain("insertRule");
    expect(js).not.toMatch(/createElement\(\s*["']style["']\s*\)/);
  });

  it("defines every token either package uses, so their defineVars hashes agree", () => {
    const [css = ""] = assets(".css");
    // StyleX names its variables `--x<hash>`; Base UI sets its own at runtime.
    const used = new Set([...css.matchAll(/var\((--x\w+)\)/g)].map(([, name]) => name));
    const defined = new Set([...css.matchAll(/(--x\w+):/g)].map(([, name]) => name));

    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});
