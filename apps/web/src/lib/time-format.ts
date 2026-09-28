/**
 * The viewer's time format: Automatic, as their locale writes the hour, or
 * 12-hour or 24-hour whatever it says. It persists in localStorage, and a
 * choice in one tab applies in the others.
 */
import { useSyncExternalStore } from "react";

export type TimeFormat = "auto" | "12h" | "24h";

const STORAGE_KEY = "via.time-format";

const CHANGE_EVENT = "via-time-format-change";

const parse = (value: string | null): TimeFormat =>
  value === "12h" || value === "24h" ? value : "auto";

// Private windows and blocked site data make storage throw; the choice then
// lasts only as long as the page.
let unstored: TimeFormat = "auto";

const current = (): TimeFormat => {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return unstored;
  }
};

/** Chooses the time format: applies it at once and remembers it for the next visit. */
export function setTimeFormat(format: TimeFormat) {
  unstored = format;

  try {
    if (format === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, format);
  } catch {
    // Nothing to persist to.
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
}

const subscribe = (onChange: () => void) => {
  // Another tab chose a format: follow it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };

  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
};

/** The current choice; a component using it rerenders only when it changes. */
export function useTimeFormat(): TimeFormat {
  return useSyncExternalStore(subscribe, current, () => "auto");
}
