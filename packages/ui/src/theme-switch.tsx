/**
 * ThemeSwitch: System, Light or Dark as a segmented radio group, in the
 * Tabs' motion language (the selected segment's surface springs between
 * options). It reads and sets the theme through `theme.ts`, so choosing
 * one rerenders this switch and nothing else.
 */
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons.tsx";
import { spring } from "./springs.ts";
import { setTheme, useTheme, type Theme } from "./theme.ts";
import { colors, durations, radii, shadows, space } from "./tokens.stylex.ts";

const styles = stylex.create({
  group: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s0_5,
    padding: space.s0_5,
    borderRadius: radii.item,
    backgroundColor: colors.muted,
  },
  option: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "30px",
    height: "24px",
    padding: 0,
    borderWidth: 0,
    borderRadius: "6px",
    backgroundColor: "transparent",
    color: {
      default: colors.mutedForeground,
      ":hover": colors.foreground,
    },
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `1px solid ${colors.focusRing}`,
    },
    outlineOffset: "1px",
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  checked: { color: colors.foreground },
  indicator: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    borderRadius: "6px",
    backgroundColor: colors.surface4,
    boxShadow: shadows.surface4,
  },
});

const options: ReadonlyArray<{
  readonly value: Theme;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { value: "system", label: "System", icon: <MonitorIcon size={14} /> },
  { value: "light", label: "Light", icon: <SunIcon size={14} /> },
  { value: "dark", label: "Dark", icon: <MoonIcon size={14} /> },
];

const isTheme = (value: string): value is Theme => options.some((option) => option.value === value);

export function ThemeSwitch() {
  const theme = useTheme();
  const indicator = useId();

  return (
    <RadioGroup
      aria-label="Theme"
      value={theme}
      onValueChange={(value: string) => {
        if (isTheme(value)) setTheme(value);
      }}
      {...stylex.props(styles.group)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-label={option.label}
          title={option.label}
          {...stylex.props(styles.option, theme === option.value && styles.checked)}
        >
          {theme === option.value && (
            <motion.span
              layoutId={indicator}
              transition={spring.moderate}
              {...stylex.props(styles.indicator)}
            />
          )}
          {option.icon}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
