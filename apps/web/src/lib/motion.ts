/**
 * How much the page moves: as the viewer's system asks, or reduced whatever it
 * says. It persists in localStorage, and a choice in one tab applies in the others.
 */
import { preference } from "./preference.ts";

type Motion = "system" | "reduced";

const motion = preference<Motion>(
  "via.motion",
  (value) => (value === "reduced" ? "reduced" : "system"),
  "system",
);

/** Chooses how much the page moves. */
export const setMotion = motion.set;

/** The current choice. */
export const useMotion = motion.use;
