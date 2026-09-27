/**
 * Design tokens, ported from Fluid Functionalism's `app/globals.css` and its
 * `lib/` token modules (MIT, see NOTICE), for the app's own StyleX styles
 * through `@via/ui/tokens.stylex`.
 *
 * Colours and shadows name the palette's CSS custom properties, which
 * `themeStylesheet()` in `palette.ts` sets: from the OS setting, or forced by
 * `data-theme` on an element. StyleX inlines these constants, so a forced
 * theme reaches everything under its element.
 */
import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineConsts({
  surface3: "var(--via-surface-3)",
  surface4: "var(--via-surface-4)",
  surface5: "var(--via-surface-5)",
  background: "var(--via-background)",
  foreground: "var(--via-foreground)",
  muted: "var(--via-muted)",
  mutedForeground: "var(--via-muted-foreground)",
  accent: "var(--via-accent)",
  border: "var(--via-border)",
  destructive: "var(--via-destructive)",
  destructiveSolid: "var(--via-destructive-solid)",
  destructiveHover: "var(--via-destructive-hover)",
  destructiveForeground: "var(--via-destructive-foreground)",
  destructiveSurface: "var(--via-destructive-surface)",
  destructiveLight: "var(--via-destructive-light)",
  focusRing: "#6B97FF",
  hover: "var(--via-hover)",
  active: "var(--via-active)",
  backdrop: "var(--via-backdrop)",
});

export const shadows = stylex.defineConsts({
  surface3: "var(--via-shadow-3)",
  surface4: "var(--via-shadow-4)",
  surface5: "var(--via-shadow-5)",
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
