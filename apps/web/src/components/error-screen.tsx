import * as stylex from "@stylexjs/stylex";
import { useMask } from "../lib/privacy.ts";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@via/ui";
import { colors, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Predicate } from "effect";
import { Centered } from "./centered.tsx";

const styles = stylex.create({
  title: {
    margin: 0,
    fontSize: text.title,
    letterSpacing: "-0.01em",
    fontVariationSettings: weights.bold,
    fontWeight: fontWeights.bold,
  },
  body: {
    marginBlock: `${space.s2} ${space.s6}`,
    fontSize: text.body,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  retry: { width: "100%" },
});

/** What a route shows when loading it failed, most often because via is unreachable. */
export function ErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const mask = useMask();

  return (
    <Centered>
      <div role="alert">
        <h1 {...stylex.props(styles.title)}>Couldn't load this page</h1>
        <p {...stylex.props(styles.body)}>
          {Predicate.isError(error)
            ? mask.key(error.message)
            : "Loading this page failed. Check that via is running, then try again."}
        </p>
      </div>
      <Button
        xstyle={styles.retry}
        onClick={() => {
          reset();
          void router.invalidate();
        }}
      >
        Try again
      </Button>
    </Centered>
  );
}
