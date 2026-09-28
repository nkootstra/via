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

const forced = "@media (forced-colors: active)";

const styles = stylex.create({
  root: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    width: "32px",
    height: "20px",
    // Forced colours draw a border, which takes a pixel of the padding.
    padding: { default: "2px", [forced]: "1px" },
    boxSizing: "border-box",
    borderWidth: { default: 0, [forced]: 1 },
    borderStyle: "solid",
    borderColor: "ButtonText",
    borderRadius: radii.full,
    backgroundColor: colors.accent,
    // The off track's edge, at 3:1 where the grey alone isn't.
    boxShadow: `inset 0 0 0 1px ${colors.borderStrong}`,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
    forcedColorAdjust: { default: null, [forced]: "none" },
    transitionProperty: "background-color, box-shadow",
    transitionDuration: durations.press,
    // A target bigger than it looks: 24px tall, and 40px square on a coarse pointer.
    "::before": {
      content: "''",
      position: "absolute",
      insetBlock: { default: "-2px", "@media (pointer: coarse)": "-10px" },
      insetInline: { default: 0, "@media (pointer: coarse)": "-4px" },
    },
  },
  checked: {
    backgroundColor: { default: colors.success, [forced]: "Highlight" },
    boxShadow: "none",
  },
  disabled: {
    opacity: 0.5,
    cursor: "default",
  },
  thumb: {
    display: "block",
    width: "16px",
    height: "16px",
    borderRadius: radii.full,
    backgroundColor: { default: "#FFFFFF", [forced]: "ButtonText" },
    boxShadow: shadows.surface3,
    transformOrigin: "left",
  },
  thumbChecked: {
    transformOrigin: "right",
    // On the Highlight track, ButtonText would all but vanish.
    backgroundColor: { default: "#FFFFFF", [forced]: "HighlightText" },
  },
});

export interface SwitchProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  /** The switch's accessible name, when no visible label names it. */
  readonly "aria-label"?: string;
  readonly disabled?: boolean;
  /** Its change is still saving: announced, without dimming the switch as `disabled` would. */
  readonly "aria-busy"?: boolean;
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
        // whileTap would make the thumb a tab stop of its own; the switch is the one.
        tabIndex={-1}
        initial={false}
        // Pressed, the thumb stretches 3px toward the far side, scaled from the
        // edge it rests against, so nothing is laid out again.
        animate={{ x: checked ? 12 : 0 }}
        whileTap={disabled ? {} : { scaleX: 19 / 16 }}
        transition={spring.moderate}
        {...stylex.props(styles.thumb, checked && styles.thumbChecked)}
      />
    </BaseSwitch.Root>
  );
}
