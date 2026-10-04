import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { colors, fontWeights, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { fallbacksQuery } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import type { Fallback } from "../../api/types.ts";
import { ArrowRightIcon } from "../../components/icons.tsx";
import { ModelName } from "../../components/model-name.tsx";
import { Page, Panel } from "../../components/page.tsx";

export const Route = createFileRoute("/_app/fallbacks")({
  head: () => ({ meta: [{ title: "Fallbacks · via" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(fallbacksQuery),
  component: Fallbacks,
});

const styles = stylex.create({
  // Rows share one panel, a hairline apart, so a chain can wrap on a phone.
  rows: {
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingBlock: space.s3,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  chain: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  source: {
    margin: 0,
    minWidth: 0,
    fontFamily: fonts.mono,
    fontSize: text.code,
    fontVariationSettings: weights.semibold,
    fontWeight: fontWeights.semibold,
    color: colors.foreground,
  },
  targets: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  target: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  arrow: {
    display: "flex",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    minWidth: 0,
    maxWidth: "100%",
    paddingBlock: space.s0_5,
    paddingInline: space.s2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.item,
    fontFamily: fonts.mono,
    fontSize: text.caption,
    color: colors.foreground,
  },
});

const title = "Fallbacks";

const description =
  "When a model can't take a request, via sends it to the next model in its list, so clients get an answer instead of an error.";

/** A rule: its model, then the models it falls back to, in order. */
function Rule({ rule }: { readonly rule: Fallback }) {
  return (
    <article aria-label={rule.model} {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.chain)}>
        <h2 {...stylex.props(styles.source)}>
          <ModelName id={rule.model} />
        </h2>
        <ol aria-label="Falls back to" {...stylex.props(styles.targets)}>
          {rule.fallbacks.map((target) => (
            <li key={target} {...stylex.props(styles.target)}>
              <span {...stylex.props(styles.arrow)}>
                <ArrowRightIcon size={14} />
              </span>
              <span {...stylex.props(styles.chip)}>
                <ModelName id={target} />
              </span>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

function Fallbacks() {
  // While via pushes the state, the rules and how they stand needn't be asked for.
  const fallbacks = useSuspenseQuery({ ...fallbacksQuery, ...useLiveOptions() });

  return (
    <Page title={title} description={description}>
      <Panel>
        <div {...stylex.props(styles.rows)}>
          {fallbacks.data.map((rule) => (
            <Rule key={rule.model} rule={rule} />
          ))}
        </div>
      </Panel>
    </Page>
  );
}
