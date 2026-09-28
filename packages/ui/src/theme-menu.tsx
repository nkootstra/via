/**
 * ThemeMenuItems: System, Light or Dark as a menu's choice of one. It reads
 * and sets the theme through `theme.ts`, so choosing one rerenders these
 * items and nothing else.
 */
import type { ReactNode } from "react";
import { MonitorIcon, MoonIcon, SunIcon } from "./icons.tsx";
import { MenuRadioGroup, MenuRadioItem } from "./menu.tsx";
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

/** The theme's choice, for a Menu's content. */
export function ThemeMenuItems() {
  const theme = useTheme();

  return (
    <MenuRadioGroup
      label="Theme"
      value={theme}
      onValueChange={(value) => {
        if (isTheme(value)) setTheme(value);
      }}
    >
      {options.map((option) => (
        <MenuRadioItem
          key={option.value}
          value={option.value}
          label={option.label}
          icon={option.icon}
        />
      ))}
    </MenuRadioGroup>
  );
}
