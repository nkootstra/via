/**
 * CopyField, ported from Fluid Functionalism's input-copy (MIT, see NOTICE):
 * a read-only value that copies itself when clicked. The glyph and its word
 * crossfade copy → check (or ✕) in cells sized by their widest, and a status
 * region announces the outcome. The value wraps rather than being cut short,
 * and when the clipboard fails, as it does over plain http, a read-only field
 * hands it over to select and copy by hand, so a secret shown once isn't lost.
 */
import * as stylex from "@stylexjs/stylex";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, XIcon } from "./icons.tsx";
import { spring } from "./springs.ts";
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
import { Input } from "./field.tsx";
import { visuallyHidden } from "./visually-hidden.tsx";

const statuses = ["idle", "copied", "failed"] as const;

type Status = (typeof statuses)[number];

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
  },
  label: {
    fontSize: text.body,
    fontVariationSettings: weights.normal,
    fontWeight: fontWeights.normal,
    color: colors.mutedForeground,
  },
  largeLabel: { textAlign: "center" },
  button: {
    display: "flex",
    alignItems: "center",
    width: "100%",
    minHeight: space.control,
    padding: 0,
    borderWidth: 0,
    borderRadius: radii.item,
    backgroundColor: "transparent",
    fontFamily: "inherit",
    fontSize: text.body,
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${colors.focusRing}`,
    },
    outlineOffset: "2px",
  },
  value: {
    flex: 1,
    minWidth: 0,
    textAlign: "start",
    overflowWrap: "anywhere",
    wordBreak: "break-all",
    fontFamily: fonts.mono,
    fontSize: text.code,
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
    fontWeight: fontWeights.normal,
    color: {
      default: colors.mutedForeground,
      [stylex.when.ancestor(":hover")]: colors.foreground,
    },
    transitionProperty: "color",
    transitionDuration: durations.fast,
  },
  failed: { color: colors.destructive },
  // A value to read off and type elsewhere, such as a login code.
  largeButton: {
    height: "auto",
    paddingBlock: space.s2,
  },
  largeValue: {
    fontSize: text.stat,
    letterSpacing: "0.1em",
    textAlign: "center",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
  cell: {
    display: "inline-grid",
    placeItems: "center",
  },
  stacked: {
    gridArea: "1 / 1",
    display: "flex",
  },
  manual: { marginTop: space.s1 },
});

// The swap: the arriving glyph or word springs in and the leaving one eases
// out on the fast tier's quicker exit, so an appear always outlasts a
// disappear. With less motion asked for, they only fade.
const SHOWN = { opacity: 1, scale: 1, filter: "blur(0px)" };

const HIDDEN = { opacity: 0, scale: 0.6, filter: "blur(4px)" };

const enter = { type: "spring", duration: 0.2, bounce: 0 } as const;

const leave = { type: "tween", ...spring.fast.exit, ease: "easeOut" } as const;

function Swap({ shown, children }: { readonly shown: boolean; readonly children: ReactNode }) {
  const still = useReducedMotion() ?? false;

  return (
    <motion.span
      initial={false}
      animate={still ? { opacity: shown ? 1 : 0 } : shown ? SHOWN : HIDDEN}
      transition={shown ? enter : leave}
      {...stylex.props(styles.stacked)}
    >
      {children}
    </motion.span>
  );
}

const words = { idle: "Copy", copied: "Copied", failed: "Couldn't copy" } as const;

const announcements = {
  idle: "",
  copied: "Copied",
  failed: "Couldn't copy. Select it and copy it by hand.",
} as const;

export interface CopyFieldProps {
  readonly value: string;
  /** Shown above the value, and names the button: "Copy <label>". */
  readonly label?: string;
  /** Called once the value is on the clipboard. */
  readonly onCopy?: () => void;
  /** `large` shows the value big and centred, for a code to read off and type. */
  readonly size?: "default" | "large";
}

export function CopyField({ value, label, onCopy, size = "default" }: CopyFieldProps) {
  const large = size === "large";
  const [status, setStatus] = useState<Status>("idle");
  // Once the clipboard has failed, the value stays on hand until a copy works.
  const [byHand, setByHand] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Unmounting cancels a pending reset, and a copy that settles after it starts none.
  const attach = useCallback((element: HTMLDivElement) => {
    root.current = element;

    return () => {
      root.current = null;
      clearTimeout(reset.current);
    };
  }, []);

  // The outcome shows for two seconds; a new attempt restarts the clock.
  const settle = (outcome: Status) => {
    if (root.current === null) return;

    clearTimeout(reset.current);
    setStatus(outcome);
    reset.current = setTimeout(() => setStatus("idle"), 2000);
  };

  const copy = () => {
    // Outside a secure context there is no clipboard, and the call rejects.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => {
          settle("copied");
          setByHand(false);
          onCopy?.();
        },
        () => {
          settle("failed");
          setByHand(true);
        },
      );
  };

  return (
    <div ref={attach} {...stylex.props(styles.root)}>
      {label !== undefined && (
        <span {...stylex.props(styles.label, large && styles.largeLabel)}>{label}</span>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label={label === undefined ? "Copy" : `Copy ${label}`}
        aria-describedby={`${id}-value`}
        {...stylex.props(stylex.defaultMarker(), styles.button, large && styles.largeButton)}
      >
        <span
          id={`${id}-value`}
          title={large ? undefined : value}
          {...stylex.props(styles.value, large && styles.largeValue)}
        >
          <mark {...stylex.props(styles.mark)}>{value}</mark>
        </span>
        <span {...stylex.props(styles.action, status === "failed" && styles.failed)}>
          <span aria-hidden="true" {...stylex.props(styles.cell)}>
            <Swap shown={status === "idle"}>
              <CopyIcon size={14} />
            </Swap>
            <Swap shown={status === "copied"}>
              <CheckIcon size={14} />
            </Swap>
            <Swap shown={status === "failed"}>
              <XIcon size={14} />
            </Swap>
          </span>
          <span aria-hidden="true" {...stylex.props(styles.cell)}>
            {statuses.map((each) => (
              <Swap key={each} shown={status === each}>
                {words[each]}
              </Swap>
            ))}
          </span>
        </span>
      </button>
      {byHand && (
        <div {...stylex.props(styles.manual)}>
          <Input
            readOnly
            value={value}
            aria-label={
              label === undefined ? "Value, to copy by hand" : `${label}, to copy by hand`
            }
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
      {/* An <output> is a polite status region; the explicit aria-live is
          for screen readers that don't treat it as one yet. */}
      <output aria-live="polite" {...stylex.props(visuallyHidden)}>
        {announcements[status]}
      </output>
    </div>
  );
}
