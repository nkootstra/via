/**
 * The page via opens on: the Overview, or the Usage page. It persists in
 * localStorage, and a choice in one tab applies in the others.
 */
import { preference } from "./preference.ts";

type StartPage = "overview" | "usage";

const startPage = preference<StartPage>(
  "via.start-page",
  (value) => (value === "usage" ? "usage" : "overview"),
  "overview",
);

/** Chooses the page via opens on. */
export const setStartPage = startPage.set;

/** The current choice. */
export const useStartPage = startPage.use;

/** Where the chosen start page is, as a path under the app. */
export const startPath = () => (startPage.get() === "usage" ? "/usage" : "/overview");
