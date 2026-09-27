/**
 * Switch, in Fluid Functionalism's style (MIT, see NOTICE): a pill whose
 * thumb springs across when toggled and stretches a little while pressed.
 * Base UI gives it the `switch` role, `aria-checked`, and Space and Enter.
 */
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { spring } from "./springs.ts";
import { colors, durations, radii, shadows } from "./tokens.stylex.ts";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    width: "32px",
    height: "20px",
    padding: "2px",
    boxSizing: "border-box",
    borderWidth: 0,
    borderRadius: radii.full,
    backgroundColor: colors.accent,
    cursor: "pointer",
    outline: "none",
    boxShadow: {
      default: null,
      ":focus-visible": `0 0 0 1px ${colors.background}, 0 0 0 2px ${colors.focusRing}`,
    },
    transitionProperty: "background-color",
    transitionDuration: durations.press,
  },
  checked: { backgroundColor: "#22c55e" },
  disabled: {
    opacity: 0.5,
    cursor: "default",
  },
  thumb: {
    display: "block",
    width: "16px",
    height: "16px",
    borderRadius: radii.full,
    backgroundColor: "#FFFFFF",
    boxShadow: shadows.surface3,
  },
});

export interface SwitchProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** The switch's accessible name, when no visible label names it. */
  readonly "aria-label"?: string;
  readonly disabled?: boolean;
}

export function Switch({ checked, onCheckedChange, disabled = false, ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root
      {...props}
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next: boolean) => onCheckedChange(next)}
      {...stylex.props(styles.root, checked && styles.checked, disabled && styles.disabled)}
    >
      <motion.span
        aria-hidden="true"
        initial={false}
        animate={{ x: checked ? 12 : 0 }}
        whileTap={disabled ? {} : { width: 19, x: checked ? 9 : 0 }}
        transition={spring.moderate}
        {...stylex.props(styles.thumb)}
      />
    </BaseSwitch.Root>
  );
}
