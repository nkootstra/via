// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { themeScript, themeScriptHash } from "@via/ui";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

const outDir = mkdtempSync(join(tmpdir(), "via-web-build-"));

const client = join(outDir, "client");

const read = (file: string) => readFileSync(join(client, file), "utf8");

// The production build, as via will serve it: a static SPA shell and assets.
describe("the built SPA shell", () => {
  beforeAll(async () => {
    const builder = await createBuilder({
      root,
      logLevel: "silent",
      environments: {
        client: { build: { outDir: client } },
        ssr: { build: { outDir: join(outDir, "server") } },
      },
    });

    await builder.buildApp();
  }, 120_000);

  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it("runs the theme script in the head, before the app, and its CSP hash matches", () => {
    const shell = read("_shell.html");
    const [, head = ""] = /<head>(.*)<\/head>/s.exec(shell) ?? [];
    const inline = `<script>${themeScript}</script>`;

    expect(head).toContain(inline);
    expect(shell.indexOf(inline)).toBeLessThan(shell.indexOf('<script type="module"'));
    expect(`sha256-${createHash("sha256").update(themeScript).digest("base64")}`).toBe(
      themeScriptHash,
    );
  });

  it("links one stylesheet with the palette, and inlines no styles", () => {
    const shell = read("_shell.html");
    const css = readdirSync(join(client, "assets")).filter((file) => file.endsWith(".css"));

    expect(css).toHaveLength(1);
    expect(shell).toContain(`<link rel="stylesheet" href="/ui/assets/${css[0]}"`);
    expect(shell).not.toContain("<style");
    expect(shell).toContain('<meta name="color-scheme" content="light dark"/>');
    expect(read(`assets/${css[0]}`)).toMatch(/\[data-theme="?dark"?\]\s*\{[^}]*--via-background:/);
  });
});
