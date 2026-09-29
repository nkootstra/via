import { describe, expect, it } from "vitest";
import { cssVariable, darkScheme, lightScheme, themeStylesheet, type Scheme } from "./palette.ts";
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
      `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--via-surface-2:${darkScheme.surface2};`,
    );
  });

  it("forces either palette, and its color-scheme, with data-theme", () => {
    expect(rule('[data-theme="dark"]')).toContain(
      `color-scheme:dark;--via-surface-2:${darkScheme.surface2};`,
    );
    expect(rule('[data-theme="light"]')).toContain(
      `color-scheme:light;--via-surface-2:${lightScheme.surface2};`,
    );
    expect(rule('[data-theme="dark"]')).toContain(
      `--via-muted-foreground:${darkScheme.mutedForeground};`,
    );
  });

  it("colours the logo's three strokes in either scheme", () => {
    for (const key of ["logoBack", "logoMiddle", "logoFront"] as const) {
      expect(rule(":root")).toContain(`${cssVariable(key)}:${lightScheme[key]};`);
      expect(rule('[data-theme="dark"]')).toContain(`${cssVariable(key)}:${darkScheme[key]};`);
    }
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

/** A `#RRGGBB` or `rgb(r g b / a)` colour as 0-255 channels and an alpha. */
const parse = (color: string) => {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);

  if (hex !== null) return { rgb: hex.slice(1).map((part) => Number.parseInt(part, 16)), alpha: 1 };
  const [r = 0, g = 0, b = 0, alpha = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);

  return { rgb: [r, g, b], alpha };
};

/** `color` painted over the opaque `ground`. */
const over = (color: string, ground: string) => {
  const top = parse(color);
  const bottom = parse(ground).rgb;

  return top.rgb.map((channel, i) => channel * top.alpha + (bottom[i] ?? 0) * (1 - top.alpha));
};

const luminance = (rgb: ReadonlyArray<number>) => {
  const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
    const c = channel / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The WCAG contrast ratio of two opaque colours. */
const contrast = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);

  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

describe.each([
  ["light", lightScheme],
  ["dark", darkScheme],
] satisfies ReadonlyArray<[string, Scheme]>)("the %s destructive colours", (_, scheme) => {
  const opaque = (color: string, ground = scheme.surface3) => over(color, ground);

  it("put text on a destructive button, resting or hovered, at AA contrast", () => {
    const text = opaque(scheme.destructiveForeground);
    expect(contrast(text, opaque(scheme.destructiveSolid))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, opaque(scheme.destructiveHover))).toBeGreaterThanOrEqual(4.5);
  });

  it("keep destructive text at AA on the page, a surface and the destructive tint", () => {
    const text = opaque(scheme.destructive);
    expect(contrast(text, opaque(scheme.background))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, opaque(scheme.surface3))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, opaque(scheme.destructiveSurface))).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(text, opaque(scheme.destructiveSurface, scheme.background)),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe.each([
  ["light", lightScheme],
  ["dark", darkScheme],
] satisfies ReadonlyArray<[string, Scheme]>)("the %s muted text", (_, scheme) => {
  const text = over(scheme.mutedForeground, scheme.surface3);

  // A Callout or Badge lays its tone's subtle tint over the surface it sits on.
  const tint = (color: string) => over(color, scheme.surface3);

  it("stays at AA on every ground it sits on: page, surface, muted, a lit row and a callout", () => {
    for (const ground of [
      over(scheme.background, scheme.background),
      over(scheme.surface3, scheme.surface3),
      over(scheme.muted, scheme.surface3),
      over(scheme.hover, scheme.surface3),
      tint(scheme.successSubtle),
      tint(scheme.warningSubtle),
      tint(scheme.destructiveSurface),
      tint(scheme.infoSubtle),
    ]) {
      expect(contrast(text, ground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe.each([
  ["light", lightScheme],
  ["dark", darkScheme],
] satisfies ReadonlyArray<[string, Scheme]>)("the %s non-text colours", (_, scheme) => {
  const grounds = [
    over(scheme.background, scheme.background),
    over(scheme.surface3, scheme.surface3),
  ];

  const track = over(scheme.muted, scheme.surface3);

  it("draw a meter's fill at 3:1 on its track, at every level", () => {
    for (const fill of [scheme.success, scheme.warning, scheme.destructiveSolid]) {
      expect(contrast(over(fill, scheme.surface3), track)).toBeGreaterThanOrEqual(3);
    }
  });

  it("draw every chart series at 3:1 on the page and a surface", () => {
    for (const series of [
      scheme.chart1,
      scheme.chart2,
      scheme.chart3,
      scheme.chart4,
      scheme.chart5,
      scheme.chart6,
      scheme.chartOther,
    ]) {
      for (const ground of grounds) {
        expect(contrast(over(series, scheme.surface3), ground)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("draw a switch's track, on or off, and the focus ring at 3:1 on the page and a surface", () => {
    for (const mark of [scheme.success, scheme.borderStrong, scheme.focusRing]) {
      for (const ground of grounds) {
        expect(contrast(over(mark, scheme.surface3), ground)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
