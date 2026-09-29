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
  surface2: "var(--via-surface-2)",
  surface3: "var(--via-surface-3)",
  surface4: "var(--via-surface-4)",
  surface5: "var(--via-surface-5)",
  background: "var(--via-background)",
  foreground: "var(--via-foreground)",
  muted: "var(--via-muted)",
  mutedForeground: "var(--via-muted-foreground)",
  accent: "var(--via-accent)",
  border: "var(--via-border)",
  borderStrong: "var(--via-border-strong)",
  destructive: "var(--via-destructive)",
  destructiveSolid: "var(--via-destructive-solid)",
  destructiveHover: "var(--via-destructive-hover)",
  destructiveForeground: "var(--via-destructive-foreground)",
  destructiveSurface: "var(--via-destructive-surface)",
  // Status fills for dots, bars and tints; red is `destructive`.
  success: "var(--via-success)",
  warning: "var(--via-warning)",
  info: "var(--via-info)",
  successSubtle: "var(--via-success-subtle)",
  warningSubtle: "var(--via-warning-subtle)",
  infoSubtle: "var(--via-info-subtle)",
  // Chart series, in order, and the grey of the rest.
  chart1: "var(--via-chart-1)",
  chart2: "var(--via-chart-2)",
  chart3: "var(--via-chart-3)",
  chart4: "var(--via-chart-4)",
  chart5: "var(--via-chart-5)",
  chart6: "var(--via-chart-6)",
  chartOther: "var(--via-chart-other)",
  focusRing: "var(--via-focus-ring)",
  hover: "var(--via-hover)",
  active: "var(--via-active)",
  backdrop: "var(--via-backdrop)",
});

export const shadows = stylex.defineConsts({
  surface2: "var(--via-shadow-2)",
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
  s8: "32px",
  // The control heights of the size ladder: default 36px, compact 28px.
  control: "36px",
  controlCompact: "28px",
});

export const fonts = stylex.defineVars({
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
});

// In rem, so a reader's larger default font or text-only zoom scales them;
// the comments give the size at the usual 16px.
export const text = stylex.defineVars({
  // A figure to read at a glance: a page's headline number, a stat tile's value.
  stat: "1.625rem", // 26px
  display: "1.375rem", // 22px
  title: "1rem", // 16px
  subtitle: "0.875rem", // 14px
  body: "0.8125rem", // 13px
  caption: "0.75rem", // 12px
  // Monospace runs large for its x-height: code sits at this share of the text around it.
  code: "0.92em",
});

// Large type tightens as it grows: display and stat sizes take `tight`, a
// title `snug`.
export const tracking = stylex.defineVars({
  tight: "-0.02em",
  snug: "-0.01em",
});

// Each weight pairs with a tighter optical size, so a label that turns heavier
// keeps its advance width and nothing around it reflows.
export const weights = stylex.defineVars({
  normal: "'wght' 400, 'opsz' 14",
  medium: "'wght' 450, 'opsz' 15",
  semibold: "'wght' 550, 'opsz' 18",
  bold: "'wght' 700, 'opsz' 25",
});

// The same weights for fonts with no weight axis, such as Segoe UI or Arial,
// which ignore `weights`: set beside it, they still render the hierarchy.
export const fontWeights = stylex.defineVars({
  normal: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
});

// CSS-side motion: colour and shadow transitions that don't need a spring.
export const durations = stylex.defineVars({
  fast: "80ms",
  // A change of state worth seeing happen, such as a meter changing colour.
  moderate: "200ms",
  press: "180ms",
  pressEase: "cubic-bezier(0.23, 1, 0.32, 1)",
});
