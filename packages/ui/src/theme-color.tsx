/**
 * ThemeColor: the browser chrome's tint, the page's background. It follows
 * the theme choice: under System, one per colour scheme for the OS to pick
 * from; under a chosen theme, that theme's alone. Render it in `<head>`.
 * It renders System until hydrated, matching the prerendered page, so the
 * first paint takes the OS's tint.
 */
import { themeColors } from "./palette.ts";
import { useTheme } from "./theme.ts";

export function ThemeColor() {
  const theme = useTheme();

  return theme === "system" ? (
    <>
      <meta name="theme-color" media="(prefers-color-scheme: light)" content={themeColors.light} />
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content={themeColors.dark} />
    </>
  ) : (
    <meta name="theme-color" content={themeColors[theme]} />
  );
}
