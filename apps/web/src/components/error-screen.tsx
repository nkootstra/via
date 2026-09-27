import * as stylex from "@stylexjs/stylex";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@via/ui";
import { colors, space, text, weights } from "@via/ui/tokens.stylex";
import { Predicate } from "effect";
import { Centered } from "./centered.tsx";

const styles = stylex.create({
  title: {
    margin: 0,
    fontSize: text.title,
    fontVariationSettings: weights.bold,
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

  return (
    <Centered>
      <div role="alert">
        <h1 {...stylex.props(styles.title)}>Something's in the way</h1>
        <p {...stylex.props(styles.body)}>
          {Predicate.isError(error) ? error.message : "Loading this page failed."}
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
