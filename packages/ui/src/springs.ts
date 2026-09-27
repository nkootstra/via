/**
 * Motion tokens for `motion`, from Fluid Functionalism's `lib/springs.ts`
 * (MIT, see NOTICE). Each tier is an enter spring; its `exit` is a plain
 * tween one tier quicker, so a dismissal reads as crisp rather than the
 * entrance replayed. The bigger the thing that moves, the slower the tier.
 */
export const spring = {
  /** Hover, focus rings, fades, selection indicators. */
  fast: { type: "spring", duration: 0.08, bounce: 0, exit: { duration: 0.06 } },
  /** Short travel that must land exactly: tab indicators, popups. */
  moderate: { type: "spring", duration: 0.16, bounce: 0, exit: { duration: 0.12 } },
  /** Large surfaces: dialogs, toasts. */
  slow: { type: "spring", duration: 0.24, bounce: 0.12, exit: { duration: 0.16 } },
} as const;
