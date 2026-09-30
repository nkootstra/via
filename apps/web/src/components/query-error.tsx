import * as stylex from "@stylexjs/stylex";
import { useMask } from "../lib/privacy.ts";
import { Button, Callout } from "@via/ui";
import { space, fontWeights, weights } from "@via/ui/tokens.stylex";
import { Predicate } from "effect";

const styles = stylex.create({
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s3,
  },
  title: { fontVariationSettings: weights.semibold, fontWeight: fontWeights.semibold },
  text: { margin: 0 },
});

/**
 * What a list shows when fetching it failed, in place of its empty state, so
 * "via is down" never reads as "you have none". The error's message says how
 * to fix it, so it adds nothing of its own.
 */
export function QueryError({
  what,
  error,
  onRetry,
}: {
  /** What didn't load, as the list names it: "keys", "accounts". */
  readonly what: string;
  /** Why, as a route's error boundary hands it over: most often an Error. */
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const mask = useMask();

  return (
    <Callout tone="danger" role="alert">
      <div {...stylex.props(styles.row)}>
        <p {...stylex.props(styles.text)}>
          <span {...stylex.props(styles.title)}>Couldn't load {what}.</span>{" "}
          {Predicate.isError(error)
            ? mask.key(error.message)
            : "Check that via is running, then try again."}
        </p>
        <Button variant="secondary" size="compact" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Callout>
  );
}
