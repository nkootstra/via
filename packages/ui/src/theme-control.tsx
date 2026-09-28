/**
 * ThemeControl: System, Light or Dark as a segmented choice of one. It reads
 * and sets the theme through `theme.ts`, so choosing one rerenders this
 * control and nothing else.
 */
import type { ReactNode } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons.tsx";
import { SegmentedControl, SegmentedItem } from "./segmented-control.tsx";
import { setTheme, useTheme, type Theme } from "./theme.ts";

const options: ReadonlyArray<{
  readonly value: Theme;
  readonly label: string;
  readonly icon: ReactNode;
}> = [
  { value: "system", label: "System", icon: <MonitorIcon size={16} /> },
  { value: "light", label: "Light", icon: <SunIcon size={16} /> },
  { value: "dark", label: "Dark", icon: <MoonIcon size={16} /> },
];

const isTheme = (value: string): value is Theme => options.some((option) => option.value === value);

export interface ThemeControlProps {
  /** The control's accessible name, when no visible label names it. */
  readonly "aria-label"?: string;
  /** The visible label that names the control. */
  readonly "aria-labelledby"?: string;
}

/** The theme's choice, as a setting. */
export function ThemeControl(props: ThemeControlProps) {
  const theme = useTheme();

  return (
    <SegmentedControl
      {...props}
      value={theme}
      onValueChange={(value) => {
        if (isTheme(value)) setTheme(value);
      }}
    >
      {options.map((option) => (
        <SegmentedItem
          key={option.value}
          value={option.value}
          label={option.label}
          icon={option.icon}
        />
      ))}
    </SegmentedControl>
  );
}
