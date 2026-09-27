/**
 * Field and Input, ported from Fluid Functionalism's input group (MIT, see
 * NOTICE). The field is quiet at rest: no ring, no fill, until the pointer
 * or focus reaches it. Base UI's Field wires the label to the control, the
 * error into its `aria-describedby`, and `invalid` into `aria-invalid`.
 */
import { Field as BaseField } from "@base-ui/react/field";
import { Input as BaseInput } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import { useRef, type ComponentProps, type ReactNode } from "react";
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
  // The box that draws the field: the input and any adornments sit inside
  // it, so hover and focus light one border around all of them.
  box: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    width: "100%",
    height: space.control,
    borderRadius: radii.item,
    color: colors.mutedForeground,
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${colors.muted} 50%, transparent)`,
      ":focus-within": colors.surface3,
    },
    boxShadow: {
      default: "0 0 0 1px transparent",
      ":hover": `0 0 0 1px ${colors.border}`,
      ":focus-within": `0 0 0 1px ${colors.border}`,
    },
    transitionProperty: "background-color, box-shadow",
    transitionDuration: durations.fast,
  },
  // Shows at rest, for a field that stands alone rather than in a form. Its
  // border is already drawn, so hover deepens it and focus tints it.
  sunken: {
    backgroundColor: {
      default: colors.muted,
      ":hover": colors.muted,
      ":focus-within": colors.surface3,
    },
    boxShadow: {
      default: `0 0 0 1px ${colors.border}`,
      ":hover": `0 0 0 1px color-mix(in srgb, ${colors.mutedForeground} 35%, ${colors.border})`,
      ":focus-within": `0 0 0 1px color-mix(in srgb, ${colors.focusRing} 70%, ${colors.border})`,
    },
  },
  invalidBox: {
    backgroundColor: {
      default: "transparent",
      ":hover": `color-mix(in srgb, ${colors.destructiveLight} 60%, transparent)`,
      ":focus-within": colors.surface3,
    },
    boxShadow: {
      default: "0 0 0 1px transparent",
      ":hover": `0 0 0 1px color-mix(in srgb, ${colors.destructive} 50%, transparent)`,
      ":focus-within": `0 0 0 1px color-mix(in srgb, ${colors.destructive} 50%, transparent)`,
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
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    color: colors.foreground,
    "::placeholder": { color: colors.mutedForeground },
  },
  afterLeading: { paddingLeft: space.s1_5 },
  leading: {
    display: "flex",
    flexShrink: 0,
    paddingLeft: space.s2_5,
    cursor: "text",
  },
  trailing: {
    display: "flex",
    flexShrink: 0,
    paddingRight: space.s1,
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
export function Input({ leading, trailing, sunken = false, ...props }: InputProps) {
  const input = useRef<HTMLElement>(null);

  return (
    <BaseInput
      {...props}
      ref={input}
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
                input.current?.focus();
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
