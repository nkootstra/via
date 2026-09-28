/**
 * The two colour schemes, ported from Fluid Functionalism's `app/globals.css`
 * (MIT, see NOTICE), and the stylesheet that picks between them.
 *
 * The palette is plain CSS custom properties rather than StyleX variables, so
 * a static stylesheet can choose it before any script runs: the OS setting by
 * default, or `data-theme="light"` / `"dark"` on any element, `<html>`
 * included, which wins either way. `tokens.stylex.ts` names the same
 * properties for the components' styles.
 */

// Light shadows stack halving drops; dark ones add an inset highlight and
// ring. The recipes differ in structure, so each theme is written out whole.
const LIGHT_DROP = "rgb(0 0 0 / 0.06)";

const DARK_DROP = "rgba(0,0,0,0.18)";

export const lightScheme = {
  // The surface ladder: light steps up to flat white and lets the shadow do
  // the work. Only the steps a component sits on are here.
  surface2: "#FCFCFC",
  surface3: "#FFFFFF",
  surface4: "#FFFFFF",
  surface5: "#FFFFFF",
  background: "#FAFAFA",
  foreground: "#171717",
  muted: "#F4F4F5",
  // #737373 drops under AA on the muted fill, a lit row and the callout tints.
  mutedForeground: "#666666",
  accent: "#E5E5E5",
  border: "color-mix(in oklab, #171717 12%, transparent)",
  // A boundary that must be seen, such as an off switch's track: 3:1 on a surface.
  borderStrong: "#8A8A8A",
  // Blue at 3:1 on every ground, drawn as an outline so forced colours keep it.
  focusRing: "#2563EB",
  // Destructive red: text and icons at AA on any surface and on the tint; a
  // solid fill, with a darker hover, that carries white text at AA; and a tint
  // that marks a lit destructive row. The dark scheme's text red is too light
  // to carry white, so the fill is a colour of its own.
  destructive: "#C81E1E",
  destructiveSolid: "#C81E1E",
  destructiveHover: "#A51A1A",
  destructiveForeground: "#FFFFFF",
  destructiveSurface: "rgb(200 30 30 / 0.08)",
  // Status fills: a dot, a bar or a switch, never text, at 3:1 on a surface
  // and on the muted track a meter fills. Each has one subtle tint, under
  // text: a badge, a callout. Red's is `destructiveSurface`.
  success: "#15A045",
  warning: "#D07005",
  info: "#3B82F6",
  successSubtle: "rgb(21 160 69 / 0.12)",
  warningSubtle: "rgb(208 112 5 / 0.12)",
  infoSubtle: "rgb(59 130 246 / 0.12)",
  // The logo's strokes, back to front: cool greys stepped by lightness, each
  // at 3:1 on every surface. The front stroke anchors the mark, so it sits
  // nearest the text colour in either scheme.
  logoBack: "#878D94",
  logoMiddle: "#555B63",
  logoFront: "#161B22",
  // Surface-relative overlays: they tint whatever elevation they sit on.
  hover: "rgb(0 0 0 / 0.04)",
  active: "rgb(0 0 0 / 0.07)",
  backdrop: "rgb(0 0 0 / 0.4)",
  shadow2: `0 0 0 1px ${LIGHT_DROP}, 0 1px 1px -0.5px ${LIGHT_DROP}`,
  shadow3: `0 0 0 1px ${LIGHT_DROP}, 0 1px 1px -0.5px ${LIGHT_DROP}, 0 3px 3px -1.5px ${LIGHT_DROP}`,
  shadow4: `0 0 0 1px ${LIGHT_DROP}, 0 1px 1px -0.5px ${LIGHT_DROP}, 0 3px 3px -1.5px ${LIGHT_DROP}, 0 6px 6px -3px ${LIGHT_DROP}`,
  shadow5: `0 0 0 1px ${LIGHT_DROP}, 0 1px 1px -0.5px ${LIGHT_DROP}, 0 3px 3px -1.5px ${LIGHT_DROP}, 0 6px 6px -3px ${LIGHT_DROP}, 0 12px 12px -6px ${LIGHT_DROP}`,
} as const;

export type Scheme = { readonly [Key in keyof typeof lightScheme]: string };

export const darkScheme: Scheme = {
  // Dark surfaces add white as they rise.
  surface2: "#1E1E1E",
  surface3: "#252525",
  surface4: "#2C2C2C",
  surface5: "#333333",
  background: "#171717",
  foreground: "#F5F5F5",
  muted: "#1E1E1E",
  mutedForeground: "#A3A3A3",
  accent: "#525252",
  border: "color-mix(in oklab, #F5F5F5 12%, transparent)",
  borderStrong: "#737373",
  focusRing: "#6B97FF",
  destructive: "#F87171",
  destructiveSolid: "#DC2626",
  destructiveHover: "#B91C1C",
  destructiveForeground: "#FFFFFF",
  destructiveSurface: "rgb(248 113 113 / 0.12)",
  success: "#22C55E",
  warning: "#F59E0B",
  info: "#3B82F6",
  successSubtle: "rgb(34 197 94 / 0.12)",
  warningSubtle: "rgb(245 158 11 / 0.12)",
  infoSubtle: "rgb(59 130 246 / 0.12)",
  logoBack: "#6D7279",
  logoMiddle: "#A6ABB2",
  logoFront: "#F3F5F8",
  hover: "rgb(255 255 255 / 0.06)",
  active: "rgb(255 255 255 / 0.1)",
  backdrop: "rgb(0 0 0 / 0.8)",
  shadow2: `inset 0 1px 0 0 rgba(255,255,255,0.01), inset 0 0 0 1px rgba(255,255,255,0.02), 0 1px 1px -0.5px ${DARK_DROP}`,
  shadow3: `inset 0 1px 0 0 rgba(255,255,255,0.02), inset 0 0 0 1px rgba(255,255,255,0.01), 0 0 0 1px rgba(0,0,0,0.12), 0 1px 1px -0.5px ${DARK_DROP}, 0 3px 3px -1.5px ${DARK_DROP}`,
  shadow4: `inset 0 1px 0 0 rgba(255,255,255,0.02), inset 0 0 0 1px rgba(255,255,255,0.04), 0 0 0 1px rgba(0,0,0,0.14), 0 1px 1px -0.5px ${DARK_DROP}, 0 3px 3px -1.5px ${DARK_DROP}, 0 6px 6px -3px ${DARK_DROP}`,
  shadow5: `inset 0 1px 0 0 rgba(255,255,255,0.04), inset 0 0 0 1px rgba(255,255,255,0.04), 0 0 0 1px rgba(0,0,0,0.16), 0 1px 1px -0.5px ${DARK_DROP}, 0 3px 3px -1.5px ${DARK_DROP}, 0 6px 6px -3px ${DARK_DROP}, 0 12px 12px -6px ${DARK_DROP}`,
};

/** The browser chrome's tint in each scheme: the page's background, for `<meta name="theme-color">`. */
export const themeColors = { light: lightScheme.background, dark: darkScheme.background } as const;

/** The custom property a scheme key sets: `mutedForeground` → `--via-muted-foreground`. */
export const cssVariable = (key: string) =>
  `--via-${key.replaceAll(/[A-Z]|\d+/g, (part) => `-${part.toLowerCase()}`)}`;

const declarations = (scheme: Scheme) =>
  Object.entries(scheme)
    .map(([key, value]) => `${cssVariable(key)}:${value};`)
    .join("");

/**
 * The stylesheet that sets the palette. It needs no script: the OS picks the
 * scheme until an element says otherwise, and the page's own background is
 * the palette's, so a dark page never shows a white frame while it loads.
 */
export const themeStylesheet = () =>
  [
    `:root{color-scheme:light dark;${declarations(lightScheme)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${declarations(darkScheme)}}}`,
    `[data-theme="light"]{color-scheme:light;${declarations(lightScheme)}}`,
    `[data-theme="dark"]{color-scheme:dark;${declarations(darkScheme)}}`,
    `html,body{background-color:var(--via-background);color:var(--via-foreground);}`,
    // While the theme switches, colours snap rather than every surface
    // animating its own transition.
    `[data-theme-switching] *,[data-theme-switching] *::before,[data-theme-switching] *::after{transition:none !important;}`,
  ].join("\n");
