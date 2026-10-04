import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { EmptyState, Skeleton, VisuallyHidden } from "@via/ui";
import { colors, fontWeights, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { fallbacksQuery } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import type { Fallback } from "../../api/types.ts";
import { ArrowRightIcon, FallbacksIcon } from "../../components/icons.tsx";
import { ModelName } from "../../components/model-name.tsx";
import { Page, Panel } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";

export const Route = createFileRoute("/_app/fallbacks")({
  head: () => ({ meta: [{ title: "Fallbacks · via" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(fallbacksQuery),
  pendingComponent: FallbacksLoading,
  errorComponent: FallbacksError,
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

/** The page's status region, for a screen reader alone. */
function Status({ children }: { readonly children: string }) {
  return (
    <VisuallyHidden>
      <output aria-live="polite">{children}</output>
    </VisuallyHidden>
  );
}

/** The page while the rules load: shaped like them, hidden from assistive tech, which hears the status. */
function FallbacksLoading() {
  return (
    <Page title={title} description={description}>
      <Status>Loading fallbacks…</Status>
      <Panel>
        <div aria-hidden="true" {...stylex.props(styles.rows)}>
          {[0, 1].map((index) => (
            <div key={index} {...stylex.props(styles.row)}>
              <div {...stylex.props(styles.chain)}>
                <Skeleton width="96px" height="16px" />
                <Skeleton width="80px" height="20px" />
                <Skeleton width="80px" height="20px" />
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </Page>
  );
}

/** The page when its data couldn't be loaded: its header stays, and it can try again. */
function FallbacksError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Page title={title} description={description}>
      <QueryError
        what="fallbacks"
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </Page>
  );
}

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
      {fallbacks.data.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={<FallbacksIcon size={18} />}
          title="No fallbacks yet"
          description="Add one, and when a model is cooling down or out of reach, via answers with another you choose instead of an error."
        />
      ) : (
        <Panel>
          <div {...stylex.props(styles.rows)}>
            {fallbacks.data.map((rule) => (
              <Rule key={rule.model} rule={rule} />
            ))}
          </div>
        </Panel>
      )}
    </Page>
  );
}
