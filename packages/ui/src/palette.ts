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
  surface3: "#FFFFFF",
  surface4: "#FFFFFF",
  surface5: "#FFFFFF",
  background: "#FAFAFA",
  foreground: "#171717",
  muted: "#F4F4F5",
  mutedForeground: "#737373",
  accent: "#E5E5E5",
  border: "color-mix(in oklab, #171717 12%, transparent)",
  destructive: "#EF4444",
  destructiveLight: "#FEF2F2",
  // Surface-relative overlays: they tint whatever elevation they sit on.
  hover: "rgb(0 0 0 / 0.04)",
  active: "rgb(0 0 0 / 0.07)",
  backdrop: "rgb(0 0 0 / 0.4)",
  shadow3: `0 0 0 1px ${LIGHT_DROP}, 0 1px 1px -0.5px ${LIGHT_DROP}, 0 3px 3px -1.5px ${LIGHT_DROP}`,
  shadow4: `0 0 0 1px ${LIGHT_DROP}, 0 1px 1px -0.5px ${LIGHT_DROP}, 0 3px 3px -1.5px ${LIGHT_DROP}, 0 6px 6px -3px ${LIGHT_DROP}`,
  shadow5: `0 0 0 1px ${LIGHT_DROP}, 0 1px 1px -0.5px ${LIGHT_DROP}, 0 3px 3px -1.5px ${LIGHT_DROP}, 0 6px 6px -3px ${LIGHT_DROP}, 0 12px 12px -6px ${LIGHT_DROP}`,
} as const;

export type Scheme = { readonly [Key in keyof typeof lightScheme]: string };

export const darkScheme: Scheme = {
  // Dark surfaces add white as they rise.
  surface3: "#252525",
  surface4: "#2C2C2C",
  surface5: "#333333",
  background: "#171717",
  foreground: "#F5F5F5",
  muted: "#1E1E1E",
  mutedForeground: "#A3A3A3",
  accent: "#525252",
  border: "color-mix(in oklab, #F5F5F5 12%, transparent)",
  destructive: "#F87171",
  destructiveLight: "#450A0A",
  hover: "rgb(255 255 255 / 0.06)",
  active: "rgb(255 255 255 / 0.1)",
  backdrop: "rgb(0 0 0 / 0.8)",
  shadow3: `inset 0 1px 0 0 rgba(255,255,255,0.02), inset 0 0 0 1px rgba(255,255,255,0.01), 0 0 0 1px rgba(0,0,0,0.12), 0 1px 1px -0.5px ${DARK_DROP}, 0 3px 3px -1.5px ${DARK_DROP}`,
  shadow4: `inset 0 1px 0 0 rgba(255,255,255,0.02), inset 0 0 0 1px rgba(255,255,255,0.04), 0 0 0 1px rgba(0,0,0,0.14), 0 1px 1px -0.5px ${DARK_DROP}, 0 3px 3px -1.5px ${DARK_DROP}, 0 6px 6px -3px ${DARK_DROP}`,
  shadow5: `inset 0 1px 0 0 rgba(255,255,255,0.04), inset 0 0 0 1px rgba(255,255,255,0.04), 0 0 0 1px rgba(0,0,0,0.16), 0 1px 1px -0.5px ${DARK_DROP}, 0 3px 3px -1.5px ${DARK_DROP}, 0 6px 6px -3px ${DARK_DROP}, 0 12px 12px -6px ${DARK_DROP}`,
};

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
