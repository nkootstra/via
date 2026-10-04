import * as stylex from "@stylexjs/stylex";
import { fontWeights, text, weights } from "@via/ui/tokens.stylex";
import { countdown, useNow } from "../lib/time.ts";

const styles = stylex.create({
  clock: {
    fontSize: text.body,
    fontVariantNumeric: "tabular-nums",
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
  },
});

/** When a resting state ends: the time left until `until`, ticking every second. */
export function BackIn({ until }: { readonly until: string }) {
  const left = Date.parse(until) - useNow();

  return left > 0 ? (
    <>
      Back in <span {...stylex.props(styles.clock)}>{countdown(left)}</span>
    </>
  ) : (
    "Back any moment"
  );
}
