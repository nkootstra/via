/**
 * SegmentedControl: a choice of one, as a row of segments that looks like
 * Tabs, for a setting rather than a panel. Base UI gives it the `radiogroup`
 * role, one tab stop, and arrow keys that choose as they move.
 */
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
import { SegmentFace, SegmentsProvider, useSegment, useSegments } from "./segment.tsx";

export interface SegmentedControlProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** The group's accessible name, when no visible label names it. */
  readonly "aria-label"?: string;
  /** The visible label that names the group. */
  readonly "aria-labelledby"?: string;
  readonly children?: ReactNode;
}

export function SegmentedControl({
  value,
  onValueChange,
  children,
  ...props
}: SegmentedControlProps) {
  const { state, rootProps, highlight } = useSegments();

  return (
    <SegmentsProvider value={state}>
      <RadioGroup
        {...props}
        {...rootProps}
        value={value}
        onValueChange={(next: string) => onValueChange(next)}
      >
        {highlight}
        {children}
      </RadioGroup>
    </SegmentsProvider>
  );
}

export interface SegmentedItemProps {
  readonly value: string;
  readonly label: string;
  /** A glyph before the label, hidden from screen readers. */
  readonly icon?: ReactNode;
}

export function SegmentedItem({ value, label, icon }: SegmentedItemProps) {
  const { look, ...segment } = useSegment(value);

  return (
    <Radio.Root
      value={value}
      nativeButton
      {...segment}
      render={(props, state) => (
        <button {...props} {...look(state.checked)}>
          <SegmentFace label={label} icon={icon} selected={state.checked} />
        </button>
      )}
    />
  );
}
