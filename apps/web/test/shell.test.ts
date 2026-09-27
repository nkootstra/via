// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { themeScript, themeScriptHash } from "@via/ui";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// The build (`bun run build`, which turbo runs before these tests) is read, not
// redone here: via's own tests serve it, and a second build would race them.
const client = join(root, "dist", "client");

const read = (file: string) => readFileSync(join(client, file), "utf8");

const sha256 = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;

// The production build, as via will serve it: a static SPA shell and assets.
describe("the built SPA shell", () => {
  it("runs the theme script in the head, before the app, and its CSP hash matches", () => {
    const shell = read("_shell.html");
    const [, head = ""] = /<head>(.*)<\/head>/s.exec(shell) ?? [];
    const inline = `<script>${themeScript}</script>`;

    expect(head).toContain(inline);
    expect(shell.indexOf(inline)).toBeLessThan(shell.indexOf('<script type="module"'));
    expect(sha256(themeScript)).toBe(themeScriptHash);
  });

  it("links one stylesheet with the palette, and inlines no styles", () => {
    const shell = read("_shell.html");
    const css = readdirSync(join(client, "assets")).filter((file) => file.endsWith(".css"));

    expect(css).toHaveLength(1);
    expect(shell).toContain(`<link rel="stylesheet" href="/ui/assets/${css[0]}"`);
    expect(shell).not.toContain("<style");
    expect(shell).not.toContain(" style=");
    expect(shell).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(read(`assets/${css[0]}`)).toMatch(/\[data-theme="?dark"?\]\s*\{[^}]*--via-background:/);
  });
});

type Embedded = {
  readonly shell: string;
  readonly assets: ReadonlyArray<{ path: string; file: string; contentType: string }>;
  readonly scriptHashes: ReadonlyArray<string>;
};

/** `@via/web/embedded`, as Bun, which is what imports it, sees it. */
const embedded = (): Embedded =>
  JSON.parse(
    execFileSync(
      "bun",
      ["-e", 'import { ui } from "./dist/embedded.ts"; console.log(JSON.stringify(ui))'],
      { cwd: root, encoding: "utf8" },
    ),
  );

describe("the embedded build", () => {
  it("imports every file of the build, at the path the shell asks for it", () => {
    const { shell, assets } = embedded();

    const files = readdirSync(client, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "_shell.html")
      .map((entry) => relative(client, join(entry.parentPath, entry.name)));

    expect(readFileSync(shell, "utf8")).toBe(read("_shell.html"));
    expect(assets.map(({ path }) => path).toSorted()).toEqual(
      files.map((file) => `/ui/${file}`).toSorted(),
    );

    for (const { path, file } of assets) {
      expect(readFileSync(file, "utf8")).toBe(read(path.slice("/ui/".length)));
    }
  });

  it("gives each file its content type", () => {
    const types = embedded().assets.map(({ path, contentType }) => [
      path.slice(path.lastIndexOf(".")),
      contentType,
    ]);

    expect(Object.fromEntries(types)).toEqual({
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
    });
  });

  it("hashes every inline script in the shell, the theme script's among them", () => {
    const inline = [
      ...read("_shell.html").matchAll(/<script(?![^>]*\ssrc=)[^>]*>(.*?)<\/script>/gs),
    ].map(([, script = ""]) => sha256(script));

    expect(inline.length).toBeGreaterThan(1);
    expect(embedded().scriptHashes).toEqual(inline);
    expect(inline).toContain(themeScriptHash);
  });
});
