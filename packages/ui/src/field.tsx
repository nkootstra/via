/**
 * Field and Input, ported from Fluid Functionalism's input group (MIT, see
 * NOTICE). The field is quiet at rest: no ring, no fill, until the pointer
 * or focus reaches it. Base UI's Field wires the label to the control, the
 * error into its `aria-describedby`, and `invalid` into `aria-invalid`.
 */
import { Field as BaseField } from "@base-ui/react/field";
import { Input as BaseInput } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode } from "react";
import { colors, durations, fonts, radii, space, text, weights } from "./tokens.stylex.ts";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  disabled: {
    opacity: 0.5,
    pointerEvents: "none",
  },
  label: {
    paddingLeft: space.s2_5,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    color: colors.mutedForeground,
  },
  invalidLabel: { color: colors.destructive },
  error: {
    paddingLeft: space.s2_5,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    color: colors.destructive,
  },
  input: {
    boxSizing: "border-box",
    width: "100%",
    height: space.control,
    paddingInline: space.s2_5,
    borderWidth: 0,
    borderRadius: radii.item,
    outline: "none",
    fontFamily: fonts.sans,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    color: colors.foreground,
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${colors.muted} 50%, transparent)`,
      ":focus": colors.surface3,
    },
    boxShadow: {
      default: "0 0 0 1px transparent",
      ":hover": `0 0 0 1px ${colors.border}`,
      ":focus": `0 0 0 1px ${colors.border}`,
    },
    transitionProperty: "background-color, box-shadow",
    transitionDuration: durations.fast,
    "::placeholder": { color: colors.mutedForeground },
  },
  invalidInput: {
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${colors.destructiveLight} 60%, transparent)`,
      ":focus": colors.surface3,
    },
    boxShadow: {
      default: "0 0 0 1px transparent",
      ":hover": `0 0 0 1px color-mix(in srgb, ${colors.destructive} 50%, transparent)`,
      ":focus": `0 0 0 1px color-mix(in srgb, ${colors.destructive} 50%, transparent)`,
    },
  },
});

export interface FieldProps {
  readonly label: string;
  /** Shown under the control, which is marked invalid while it is set. */
  readonly error?: string | undefined;
  readonly disabled?: boolean;
  /** The control: an Input. */
  readonly children: ReactNode;
}

export function Field({ label, error, disabled = false, children }: FieldProps) {
  const invalid = error !== undefined;

  return (
    <BaseField.Root
      invalid={invalid}
      disabled={disabled}
      {...stylex.props(styles.root, disabled && styles.disabled)}
    >
      <BaseField.Label {...stylex.props(styles.label, invalid && styles.invalidLabel)}>
        {label}
      </BaseField.Label>
      {children}
      {invalid && (
        // `match` pins the message while the caller's error stands, rather
        // than waiting for native validation.
        <BaseField.Error match {...stylex.props(styles.error)}>
          {error}
        </BaseField.Error>
      )}
    </BaseField.Root>
  );
}

export type InputProps = Omit<ComponentProps<typeof BaseInput>, "className" | "style" | "render">;

export function Input(props: InputProps) {
  return (
    <BaseInput
      {...props}
      className={(state) =>
        stylex.props(styles.input, state.valid === false && styles.invalidInput).className ?? ""
      }
    />
  );
}
