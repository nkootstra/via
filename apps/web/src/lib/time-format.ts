/**
 * The viewer's time format: Automatic, as their locale writes the hour, or
 * 12-hour or 24-hour whatever it says. It persists in localStorage, and a
 * choice in one tab applies in the others.
 */
import { preference } from "./preference.ts";

export type TimeFormat = "auto" | "12h" | "24h";

const timeFormat = preference<TimeFormat>(
  "via.time-format",
  (value) => (value === "12h" || value === "24h" ? value : "auto"),
  "auto",
);

/** Chooses the time format: applies it at once and remembers it for the next visit. */
export const setTimeFormat = timeFormat.set;

/** The current choice; a component using it rerenders only when it changes. */
export const useTimeFormat = timeFormat.use;
