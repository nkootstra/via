/**
 * The viewer's theme choice: System, Light or Dark. It lives outside React,
 * on `<html data-theme>` (none for System), and persists in localStorage.
 * The palette stylesheet does the rest in CSS, so switching rerenders only
 * the components that show the choice, not the app.
 */
import { useSyncExternalStore } from "react";
import { STORAGE_KEY } from "./theme-script.ts";

const CHANGE_EVENT = "via-theme-change";

export type Theme = "system" | "light" | "dark";

const parse = (value: string | null | undefined): Theme =>
  value === "light" || value === "dark" ? value : "system";

const current = () => parse(document.documentElement.dataset["theme"]);

// Private windows and blocked site data make storage throw; the choice then
// lasts only as long as the page.
const store = (theme: Theme) => {
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Nothing to persist to.
  }
};

const apply = (theme: Theme) => {
  const root = document.documentElement;

  // Every surface would otherwise run its own colour transition; for two
  // frames they snap instead.
  root.setAttribute("data-theme-switching", "");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.removeAttribute("data-theme-switching")),
  );

  if (theme === "system") {
    delete root.dataset["theme"];
    root.style.removeProperty("color-scheme");
  } else {
    root.dataset["theme"] = theme;
    root.style.colorScheme = theme;
  }
};

/** Chooses the theme: applies it at once and remembers it for the next visit. */
export function setTheme(theme: Theme) {
  store(theme);
  apply(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const subscribe = (onChange: () => void) => {
  // Another tab chose a theme: follow it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;

    apply(parse(event.newValue));
    onChange();
  };

  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
};

/** The current choice; a component using it rerenders only when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => "system");
}
