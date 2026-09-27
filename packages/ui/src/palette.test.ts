import { describe, expect, it } from "vitest";
import { cssVariable, darkScheme, lightScheme, themeStylesheet } from "./palette.ts";
import { colors, shadows } from "./tokens.stylex.ts";

const css = themeStylesheet();

/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (selector: string) => {
  const start = css.indexOf(`${selector}{`);

  return start === -1 ? "" : css.slice(start + selector.length + 1, css.indexOf("}", start));
};

describe("themeStylesheet", () => {
  it("defaults to the light palette and follows the OS into dark unless light is forced", () => {
    expect(rule(":root")).toContain(`--via-background:${lightScheme.background};`);
    expect(rule(":root")).toContain("color-scheme:light dark;");
    expect(css).toContain(
      `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--via-surface-3:${darkScheme.surface3};`,
    );
  });

  it("forces either palette, and its color-scheme, with data-theme", () => {
    expect(rule('[data-theme="dark"]')).toContain(
      `color-scheme:dark;--via-surface-3:${darkScheme.surface3};`,
    );
    expect(rule('[data-theme="light"]')).toContain(
      `color-scheme:light;--via-surface-3:${lightScheme.surface3};`,
    );
    expect(rule('[data-theme="dark"]')).toContain(
      `--via-muted-foreground:${darkScheme.mutedForeground};`,
    );
  });

  it("paints the page itself with the palette", () => {
    expect(rule("html,body")).toContain("background-color:var(--via-background);");
  });

  it("turns transitions off while the theme switches", () => {
    expect(css).toContain("[data-theme-switching] *");
    expect(css).toContain("transition:none !important;");
  });

  it("sets every variable the colour and shadow tokens read", () => {
    const tokens = [...Object.values(colors), ...Object.values(shadows)].filter((value) =>
      value.startsWith("var(--via-"),
    );

    expect(tokens.length).toBeGreaterThan(10);

    for (const token of tokens) {
      expect(rule(":root")).toContain(`${token.slice(4, -1)}:`);
    }
  });
});

describe("cssVariable", () => {
  it("kebab-cases a key, splitting off its digits", () => {
    expect(cssVariable("mutedForeground")).toBe("--via-muted-foreground");
    expect(cssVariable("shadow3")).toBe("--via-shadow-3");
  });
});
