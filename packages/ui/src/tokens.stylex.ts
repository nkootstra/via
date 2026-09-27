/**
 * Design tokens, ported from Fluid Functionalism's `app/globals.css` and its
 * `lib/` token modules (MIT, see NOTICE). Every value is a CSS custom
 * property, so the app's own StyleX styles can use them through
 * `@via/ui/tokens.stylex`. Dark mode follows the OS: each colour and shadow
 * carries a `prefers-color-scheme: dark` value.
 */
import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

// Light shadows stack halving drops; dark ones add an inset highlight and
// ring. The recipes differ in structure, so each theme is written out whole.
const LIGHT_DROP = "rgb(0 0 0 / 0.06)";

const DARK_DROP = "rgba(0,0,0,0.18)";

/**
 * The two palettes, each written once. `colors` and `shadows` pick between
 * them by the OS setting; a view that must show one scheme regardless (the
 * component preview) builds a `createTheme` from them.
 */
export const lightScheme = stylex.defineConsts({
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
});

export const darkScheme = stylex.defineConsts({
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
});

export const colors = stylex.defineVars({
  surface3: { default: lightScheme.surface3, [DARK]: darkScheme.surface3 },
  surface4: { default: lightScheme.surface4, [DARK]: darkScheme.surface4 },
  surface5: { default: lightScheme.surface5, [DARK]: darkScheme.surface5 },
  background: { default: lightScheme.background, [DARK]: darkScheme.background },
  foreground: { default: lightScheme.foreground, [DARK]: darkScheme.foreground },
  muted: { default: lightScheme.muted, [DARK]: darkScheme.muted },
  mutedForeground: { default: lightScheme.mutedForeground, [DARK]: darkScheme.mutedForeground },
  accent: { default: lightScheme.accent, [DARK]: darkScheme.accent },
  border: { default: lightScheme.border, [DARK]: darkScheme.border },
  destructive: { default: lightScheme.destructive, [DARK]: darkScheme.destructive },
  destructiveLight: { default: lightScheme.destructiveLight, [DARK]: darkScheme.destructiveLight },
  focusRing: "#6B97FF",
  hover: { default: lightScheme.hover, [DARK]: darkScheme.hover },
  active: { default: lightScheme.active, [DARK]: darkScheme.active },
  backdrop: { default: lightScheme.backdrop, [DARK]: darkScheme.backdrop },
});

export const shadows = stylex.defineVars({
  surface3: { default: lightScheme.shadow3, [DARK]: darkScheme.shadow3 },
  surface4: { default: lightScheme.shadow4, [DARK]: darkScheme.shadow4 },
  surface5: { default: lightScheme.shadow5, [DARK]: darkScheme.shadow5 },
});

// The "rounded" shape: items 8px, containers 12px (concentric around a 4px
// inset), and the focus ring 2px outside an item.
export const radii = stylex.defineVars({
  item: "8px",
  focusRing: "10px",
  container: "12px",
  full: "9999px",
});

export const space = stylex.defineVars({
  px: "1px",
  s0_5: "2px",
  s1: "4px",
  s1_5: "6px",
  s2: "8px",
  s2_5: "10px",
  s3: "12px",
  s4: "16px",
  s6: "24px",
  // The control heights of the size ladder: default 36px, compact 28px.
  control: "36px",
  controlCompact: "28px",
});

export const fonts = stylex.defineVars({
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
});

export const text = stylex.defineVars({
  title: "16px",
  subtitle: "14px",
  body: "13px",
  caption: "12px",
  compact: "11px",
});

// Each weight pairs with a tighter optical size, so a label that turns heavier
// keeps its advance width and nothing around it reflows.
export const weights = stylex.defineVars({
  normal: "'wght' 400, 'opsz' 14",
  medium: "'wght' 450, 'opsz' 15",
  semibold: "'wght' 550, 'opsz' 18",
  bold: "'wght' 700, 'opsz' 25",
});

// CSS-side motion: colour and shadow transitions that don't need a spring.
export const durations = stylex.defineVars({
  fast: "80ms",
  press: "180ms",
  pressEase: "cubic-bezier(0.23, 1, 0.32, 1)",
});
