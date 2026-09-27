/**
 * CopyField, ported from Fluid Functionalism's input-copy (MIT, see NOTICE):
 * a read-only value that copies itself when clicked. The glyph crossfades
 * copy → check (or ✕) in a cell that never resizes, the action's width is
 * held by an invisible "Copied", and a status region announces the outcome.
 */
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, XIcon } from "./icons.tsx";
import { spring } from "./springs.ts";
import { colors, durations, fonts, radii, space, text, weights } from "./tokens.stylex.ts";

type Status = "idle" | "copied" | "failed";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
  },
  label: {
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    color: colors.mutedForeground,
  },
  button: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    height: space.control,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.item,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    cursor: "pointer",
    outline: "none",
    boxShadow: {
      default: null,
      ":focus-visible": `0 0 0 1px ${colors.focusRing}`,
    },
  },
  value: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textAlign: "left",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: text.body,
    color: colors.foreground,
  },
  mark: {
    color: "inherit",
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":hover")]: `color-mix(in srgb, ${colors.focusRing} 20%, transparent)`,
    },
    transitionProperty: "background-color",
    transitionDuration: durations.fast,
  },
  action: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space.s1_5,
    paddingInline: space.s1_5,
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    color: {
      default: colors.mutedForeground,
      [stylex.when.ancestor(":hover")]: colors.foreground,
    },
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  failed: { color: colors.destructive },
  cell: {
    display: "inline-grid",
    placeItems: "center",
  },
  stacked: {
    gridArea: "1 / 1",
    display: "flex",
  },
  ghost: {
    gridArea: "1 / 1",
    visibility: "hidden",
  },
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

// Icon swap: the arriving glyph rides the fast tier's full duration and the
// leaving one its exit, so an appear always outlasts a disappear.
const SHOWN = { opacity: 1, scale: 1, filter: "blur(0px)" };

const HIDDEN = { opacity: 0, scale: 0.6, filter: "blur(4px)" };

const enter = { type: "tween", duration: spring.fast.duration, ease: "easeOut" } as const;

const leave = { type: "tween", ...spring.fast.exit, ease: "easeIn" } as const;

function Glyph({ shown, children }: { readonly shown: boolean; readonly children: ReactNode }) {
  return (
    <motion.span
      initial={false}
      animate={shown ? SHOWN : HIDDEN}
      transition={shown ? enter : leave}
      {...stylex.props(styles.stacked)}
    >
      {children}
    </motion.span>
  );
}

const words = { idle: "Copy", copied: "Copied", failed: "Failed" } as const;

const announcements = { idle: "", copied: "Copied", failed: "Copy failed" } as const;

export interface CopyFieldProps {
  readonly value: string;
  /** Shown above the value, and names the button: "Copy <label>". */
  readonly label?: string;
  /** Called once the value is on the clipboard. */
  readonly onCopy?: () => void;
}

export function CopyField({ value, label, onCopy }: CopyFieldProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [attempt, setAttempt] = useState(0);
  const id = useId();

  // The outcome shows for two seconds; a new attempt restarts the clock.
  useEffect(() => {
    if (attempt === 0) return;

    const timer = setTimeout(() => setStatus("idle"), 2000);

    return () => clearTimeout(timer);
  }, [attempt]);

  const copy = () => {
    // Outside a secure context there is no clipboard, and the call rejects.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => {
          setStatus("copied");
          onCopy?.();
        },
        () => setStatus("failed"),
      )
      .then(() => setAttempt((count) => count + 1));
  };

  return (
    <div {...stylex.props(styles.root)}>
      {label !== undefined && <span {...stylex.props(styles.label)}>{label}</span>}
      <button
        type="button"
        onClick={copy}
        aria-label={label === undefined ? "Copy" : `Copy ${label}`}
        aria-describedby={`${id}-value`}
        {...stylex.props(stylex.defaultMarker(), styles.button)}
      >
        <span id={`${id}-value`} {...stylex.props(styles.value)}>
          <mark {...stylex.props(styles.mark)}>{value}</mark>
        </span>
        <span {...stylex.props(styles.action, status === "failed" && styles.failed)}>
          <span aria-hidden="true" {...stylex.props(styles.cell)}>
            <Glyph shown={status === "idle"}>
              <CopyIcon size={14} />
            </Glyph>
            <Glyph shown={status === "copied"}>
              <CheckIcon size={14} />
            </Glyph>
            <Glyph shown={status === "failed"}>
              <XIcon size={14} />
            </Glyph>
          </span>
          <span aria-hidden="true" {...stylex.props(styles.cell)}>
            <span {...stylex.props(styles.ghost)}>Copied</span>
            <span {...stylex.props(styles.stacked)}>{words[status]}</span>
          </span>
        </span>
      </button>
      {/* An <output> is a polite status region; the explicit aria-live is
          for screen readers that don't treat it as one yet. */}
      <output aria-live="polite" {...stylex.props(styles.visuallyHidden)}>
        {announcements[status]}
      </output>
    </div>
  );
}
