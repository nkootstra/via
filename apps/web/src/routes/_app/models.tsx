import * as stylex from "@stylexjs/stylex";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { Button, EmptyState, Input, Skeleton, VisuallyHidden } from "@via/ui";
import { colors, fontWeights, fonts, radii, space, text, weights } from "@via/ui/tokens.stylex";
import { Schema } from "effect";
import { useDeferredValue, useRef, useState } from "react";
import { modelsQuery } from "../../api/admin.ts";
import { useLiveOptions } from "../../api/live.ts";
import type { Model } from "../../api/types.ts";
import { CodexIcon, ModelsIcon, ProviderLogo, SearchIcon } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import { QueryError } from "../../components/query-error.tsx";
import { modelEntries } from "../../lib/model-entries.ts";
import { providerName } from "../../lib/provider-name.ts";

export const Route = createFileRoute("/_app/models")({
  head: () => ({ meta: [{ title: "Models · via" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(modelsQuery),
  pendingComponent: ModelsLoading,
  errorComponent: ModelsError,
  component: Models,
});

const styles = stylex.create({
  search: { maxWidth: "360px" },
  groups: {
    display: "flex",
    flexDirection: "column",
    gap: space.s8,
  },
  // A provider's models share one panel, spaced apart rather than raised each.
  grid: {
    display: "grid",
    margin: 0,
    padding: 0,
    listStyle: "none",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))",
    rowGap: space.s4,
    columnGap: space.s6,
  },
  model: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    minWidth: 0,
  },
  loading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s8,
  },
  count: { fontVariantNumeric: "tabular-nums" },
  // Wrapped rather than cut short: an id is only useful whole.
  id: {
    overflowWrap: "anywhere",
    fontFamily: fonts.mono,
    fontSize: text.code,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  meta: {
    fontSize: text.caption,
    color: colors.mutedForeground,
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: text.code,
    color: colors.foreground,
  },
  none: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.s3,
    margin: 0,
    paddingBlock: space.s6,
    textAlign: "center",
    fontSize: text.body,
    color: colors.mutedForeground,
    borderRadius: radii.container,
  },
});

const WithContext = Schema.Struct({ context_length: Schema.Finite });

const hasContext = Schema.is(WithContext);

const compact = new Intl.NumberFormat(undefined, { notation: "compact" });

const count = new Intl.NumberFormat();

const contextOf = (model: Model) =>
  hasContext(model) ? `${compact.format(model.context_length)} context` : undefined;

const modelCount = (n: number) => `${count.format(n)} ${n === 1 ? "model" : "models"}`;

const matchCount = (n: number) => `${count.format(n)} ${n === 1 ? "match" : "matches"}`;

const title = "Models";

const description = (
  <>
    What clients can ask for at /v1/models. A Codex model takes its reasoning effort as a suffix, as
    in <code {...stylex.props(styles.code)}>gpt-5.5-high</code>; a provider’s models go by its name,
    as in <code {...stylex.props(styles.code)}>opencode-go/glm-5.2</code>.
  </>
);

/** The page's status region, for a screen reader alone. */
function Status({ children }: { readonly children: string }) {
  return (
    <VisuallyHidden>
      <output aria-live="polite">{children}</output>
    </VisuallyHidden>
  );
}

/** The page while its models load: shaped like it, hidden from assistive tech, which hears the status. */
function ModelsLoading() {
  return (
    <Page title={title} description={description}>
      <Status>Loading models…</Status>
      <div aria-hidden="true" {...stylex.props(styles.loading)}>
        <Skeleton width="min(100%, 360px)" height="36px" />
        <Panel>
          <div {...stylex.props(styles.grid)}>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} {...stylex.props(styles.model)}>
                <Skeleton width="70%" height="14px" />
                <Skeleton width="40%" height="12px" />
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </Page>
  );
}

/** The page when its data couldn't be loaded: its header stays, and it can try again. */
function ModelsError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <Page title={title} description={description}>
      <QueryError
        what="models"
        error={error}
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </Page>
  );
}

function Models() {
  const models = useSuspenseQuery({ ...modelsQuery, ...useLiveOptions() });
  const [search, setSearch] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const query = useDeferredValue(search.trim().toLowerCase());
  const list = modelEntries(models.data);
  const matches = list.filter((entry) => entry.ids.some((id) => id.toLowerCase().includes(query)));
  const groups = Map.groupBy(matches, (entry) => entry.owner);

  // Codex first, then providers by name.
  const owners = [...groups.keys()].toSorted((a, b) =>
    a === "Codex" ? -1 : b === "Codex" ? 1 : a.localeCompare(b),
  );

  // What a screen reader hears as the search narrows the list.
  const status =
    query === ""
      ? ""
      : matches.length === 0
        ? `No model matches “${search}”.`
        : matchCount(matches.length);

  const clear = () => {
    setSearch("");
    field.current?.focus();
  };

  return (
    <Page title={title} description={description}>
      <Status>{status}</Status>
      {list.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={<ModelsIcon size={18} />}
          title="No models to list"
          description="via lists Codex's models once an account is in the pool, and each configured provider's."
        />
      ) : (
        <>
          <div {...stylex.props(styles.search)}>
            <Input
              ref={field}
              type="search"
              name="search"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search models"
              placeholder={`Search ${modelCount(list.length)}…`}
              value={search}
              onValueChange={setSearch}
              sunken
              leading={<SearchIcon size={15} />}
            />
          </div>
          {owners.length === 0 ? (
            <div {...stylex.props(styles.none)}>
              No model matches “{search}”.
              <Button variant="secondary" size="compact" onClick={clear}>
                Clear search
              </Button>
            </div>
          ) : (
            <div {...stylex.props(styles.groups)}>
              {owners.map((owner) => {
                const owned = groups.get(owner) ?? [];

                return (
                  <Section
                    key={owner}
                    title={providerName(owner)}
                    icon={
                      owner === "Codex" ? (
                        <CodexIcon size={16} />
                      ) : (
                        <ProviderLogo name={owner} size={16} />
                      )
                    }
                    aside={<span {...stylex.props(styles.count)}>{modelCount(owned.length)}</span>}
                  >
                    <Panel>
                      <ul {...stylex.props(styles.grid)}>
                        {owned.map(({ model, name, efforts }) => (
                          <li key={model.id} {...stylex.props(styles.model)}>
                            {/* Named without its provider's prefix; the id it goes by on hover. */}
                            <span
                              title={name === model.id ? undefined : model.id}
                              {...stylex.props(styles.id)}
                            >
                              {name}
                            </span>
                            {efforts.length > 0 && (
                              <span {...stylex.props(styles.meta)}>
                                <VisuallyHidden>Efforts: </VisuallyHidden>
                                {efforts.join(" · ")}
                              </span>
                            )}
                            {contextOf(model) !== undefined && (
                              <span {...stylex.props(styles.meta)}>{contextOf(model)}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </Panel>
                  </Section>
                );
              })}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
