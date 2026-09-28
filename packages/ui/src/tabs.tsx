/**
 * Tabs, ported from Fluid Functionalism's Base UI tabs (MIT, see NOTICE): a
 * segmented control whose segments are tabs, each selecting a panel.
 */
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";
import { SegmentFace, SegmentsProvider, useSegment, useSegments } from "./segment.tsx";

const styles = stylex.create({
  panel: { outline: "none" },
});

export interface TabsProps {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly children?: ReactNode;
}

export function Tabs({ value, defaultValue, onValueChange, children }: TabsProps) {
  return (
    <BaseTabs.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next: string) => onValueChange?.(next)}
    >
      {children}
    </BaseTabs.Root>
  );
}

export type TabsListProps = Omit<ComponentProps<typeof BaseTabs.List>, "className" | "style">;

export function TabsList({ children, ...props }: TabsListProps) {
  const { state, rootProps, highlight } = useSegments();

  return (
    <SegmentsProvider value={state}>
      <BaseTabs.List
        {...props}
        {...rootProps}
        // Arrow keys move the selection along with focus.
        activateOnFocus
      >
        {highlight}
        {children}
      </BaseTabs.List>
    </SegmentsProvider>
  );
}

export interface TabItemProps {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export function TabItem({ value, label, disabled = false }: TabItemProps) {
  const { look, ...segment } = useSegment(value);

  return (
    <BaseTabs.Tab
      value={value}
      disabled={disabled}
      {...segment}
      render={(props, state) => (
        <button {...props} {...look(state.active)}>
          <SegmentFace label={label} selected={state.active} />
        </button>
      )}
    />
  );
}

export type TabPanelProps = Omit<ComponentProps<typeof BaseTabs.Panel>, "className" | "style">;

export function TabPanel(props: TabPanelProps) {
  return <BaseTabs.Panel {...props} {...stylex.props(styles.panel)} />;
}
