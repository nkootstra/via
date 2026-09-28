/**
 * Field and Input, ported from Fluid Functionalism's input group (MIT, see
 * NOTICE). The field is quiet at rest, a hairline and no fill, until the
 * pointer or focus reaches it. Base UI's Field wires the label to the control, the
 * error into its `aria-describedby`, and `invalid` into `aria-invalid`.
 */
import { Field as BaseField } from "@base-ui/react/field";
import { Input as BaseInput } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import type { ComponentProps, ReactNode, Ref } from "react";
import {
  colors,
  durations,
  fonts,
  radii,
  space,
  text,
  fontWeights,
  weights,
} from "./tokens.stylex.ts";

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
    paddingInlineStart: space.s2_5,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    color: colors.mutedForeground,
  },
  invalidLabel: { color: colors.destructive },
  error: {
    paddingInlineStart: space.s2_5,
    fontSize: text.caption,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.destructive,
  },
  // The box that draws the field: the input and any adornments sit inside
  // it, so hover and focus light one border and one ring around all of them.
  box: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    width: "100%",
    height: space.control,
    // A resting boundary, which forced colours draw in the system's colour.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.item,
    color: colors.mutedForeground,
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${colors.muted} 50%, transparent)`,
      ":focus-within": colors.surface3,
    },
    // The ring is the box's, an outline so forced colours keep it, and shows
    // on a click too, as a text field is typed into next. It follows the
    // input's focus alone: a trailing button draws its own.
    outline: {
      default: "none",
      ":has(> input:focus)": `2px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
    transitionProperty: "background-color, border-color",
    transitionDuration: durations.fast,
  },
  // Shows at rest, for a field that stands alone rather than in a form: a
  // fill, and a border that hover deepens.
  sunken: {
    backgroundColor: {
      default: colors.muted,
      ":hover": colors.muted,
      ":focus-within": colors.surface3,
    },
    borderColor: {
      default: colors.border,
      ":hover": `color-mix(in srgb, ${colors.mutedForeground} 35%, ${colors.border})`,
    },
  },
  invalidBox: {
    borderColor: `color-mix(in srgb, ${colors.destructive} 50%, transparent)`,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.destructiveSurface,
      ":focus-within": colors.surface3,
    },
    outline: {
      default: "none",
      ":has(> input:focus)": `2px solid ${colors.destructive}`,
    },
  },
  input: {
    boxSizing: "border-box",
    flex: 1,
    minWidth: 0,
    height: "100%",
    paddingInline: space.s2_5,
    borderWidth: 0,
    borderRadius: radii.item,
    outline: "none",
    backgroundColor: "transparent",
    fontFamily: fonts.sans,
    // iOS zooms the page into a field under 16px when it takes focus.
    fontSize: { default: text.body, "@media (pointer: coarse)": "16px" },
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    color: colors.foreground,
    "::placeholder": { color: colors.mutedForeground },
  },
  afterLeading: { paddingInlineStart: space.s1_5 },
  leading: {
    display: "flex",
    flexShrink: 0,
    paddingInlineStart: space.s2_5,
    cursor: "text",
  },
  trailing: {
    display: "flex",
    flexShrink: 0,
    paddingInlineEnd: space.s1,
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

export interface InputProps extends Omit<
  ComponentProps<typeof BaseInput>,
  "className" | "style" | "render" | "ref"
> {
  /** The underlying `<input>`, for a screen that moves focus to it. */
  readonly ref?: Ref<HTMLInputElement>;
  /** Drawn inside the field before the text, such as a search glyph. Clicking it focuses the input. */
  readonly leading?: ReactNode;
  /** Drawn inside the field after the text, such as a show-key button. */
  readonly trailing?: ReactNode;
  /** Shows the field at rest, for one that stands alone rather than in a form. */
  readonly sunken?: boolean;
}

/**
 * The input sits borderless in a box that owns the field's look, so leading
 * and trailing adornments share one border and one focus state with it.
 */
export function Input({ leading, trailing, sunken = false, ref, ...props }: InputProps) {
  return (
    <BaseInput
      {...props}
      ref={ref}
      render={(inputProps, state) => (
        <div
          {...stylex.props(
            styles.box,
            sunken && styles.sunken,
            state.valid === false && styles.invalidBox,
          )}
        >
          {leading !== undefined && (
            <span
              aria-hidden="true"
              // Keep the press from taking focus, then hand it to the input.
              onMouseDown={(event) => {
                event.preventDefault();
                event.currentTarget.parentElement?.querySelector("input")?.focus();
              }}
              {...stylex.props(styles.leading)}
            >
              {leading}
            </span>
          )}
          <input
            {...inputProps}
            {...stylex.props(styles.input, leading !== undefined && styles.afterLeading)}
          />
          {trailing !== undefined && <span {...stylex.props(styles.trailing)}>{trailing}</span>}
        </div>
      )}
    />
  );
}
