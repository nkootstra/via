import type { MotionStyle } from "motion/react";
import type { HTMLAttributes } from "react";

/**
 * The props Base UI hands a `render` function, fit for a motion element:
 * minus the DOM animation and drag handlers, which motion redefines with its
 * own signatures and Base UI never attaches, and with the style typed as
 * motion's.
 */
export function forMotion<P extends HTMLAttributes<HTMLElement>>({
  onAnimationStart: _onAnimationStart,
  onAnimationEnd: _onAnimationEnd,
  onAnimationIteration: _onAnimationIteration,
  onDrag: _onDrag,
  onDragStart: _onDragStart,
  onDragEnd: _onDragEnd,
  style,
  ...props
}: P) {
  // SAFETY: every CSSProperties value is a valid MotionStyle value. The types
  // differ only in that React's optional keys also admit `undefined` under
  // exactOptionalPropertyTypes, and React skips undefined entries anyway.
  return { ...props, style: (style ?? {}) as MotionStyle };
}
