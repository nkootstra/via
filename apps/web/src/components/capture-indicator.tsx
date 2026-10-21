/**
 * A quiet word, on the Conversations tab, that via is keeping the prompts of
 * failed requests: a steady dot and a link to the setting that turns it off.
 * It shows only while the setting is on.
 */
import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { colors, durations, radii, space, text } from "@via/ui/tokens.stylex";
import { captureQuery } from "../api/admin.ts";
import { useLiveOptions } from "../api/live.ts";

/** The setting's anchor on the settings page. */
export const CAPTURE_SETTING = "keep-failed-prompts";

const styles = stylex.create({
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s2,
    height: "28px",
    paddingInline: space.s2_5,
    borderRadius: radii.full,
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    fontSize: text.caption,
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    textDecorationLine: "none",
    whiteSpace: "nowrap",
    transitionProperty: "background-color, color",
    transitionDuration: durations.fast,
    outline: { default: "none", ":focus-visible": `2px solid ${colors.focusRing}` },
    outlineOffset: "2px",
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: radii.full,
    backgroundColor: colors.info,
    boxShadow: `0 0 0 3px color-mix(in oklab, ${colors.info} 18%, transparent)`,
  },
});

export function CaptureIndicator() {
  const capture = useQuery({ ...captureQuery, ...useLiveOptions() });

  if (capture.data?.keepFailedPrompts !== true) return null;

  return (
    <Link
      to="/settings"
      hash={CAPTURE_SETTING}
      title="via keeps what a failed request sent, redacted, for 7 days. Change it in Settings."
      {...stylex.props(styles.link)}
    >
      <span aria-hidden="true" {...stylex.props(styles.dot)} />
      Capturing failed prompts
    </Link>
  );
}
