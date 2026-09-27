import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Badge, EmptyState, Input, Skeleton } from "@via/ui";
import { colors, fonts, radii, space, text } from "@via/ui/tokens.stylex";
import { Schema } from "effect";
import { useDeferredValue, useState } from "react";
import { modelsQuery } from "../../api/admin.ts";
import type { Model } from "../../api/types.ts";
import { ModelsIcon, SearchIcon } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";

export const Route = createFileRoute("/_app/models")({
  head: () => ({ meta: [{ title: "Models · via" }] }),
  component: Models,
});

const styles = stylex.create({
  // A sunken well, so the search shows at rest, with the magnifier inside.
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.s0_5,
    maxWidth: "360px",
    paddingLeft: space.s2_5,
    borderRadius: radii.item,
    backgroundColor: colors.muted,
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
    color: colors.mutedForeground,
  },
  searchIcon: { display: "flex", flexShrink: 0 },
  groups: {
    display: "flex",
    flexDirection: "column",
    gap: "28px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 240px), 1fr))",
    gap: space.s2,
  },
  model: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    minWidth: 0,
  },
  id: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: fonts.mono,
    fontSize: text.body,
    color: colors.foreground,
  },
  meta: {
    fontSize: text.compact,
    color: colors.mutedForeground,
  },
  none: {
    display: "block",
    margin: 0,
    paddingBlock: space.s6,
    textAlign: "center",
    fontSize: text.body,
    color: colors.mutedForeground,
    borderRadius: radii.container,
  },
});

const OwnedBy = Schema.Struct({ owned_by: Schema.String });

const WithContext = Schema.Struct({ context_length: Schema.Finite });

const isOwned = Schema.is(OwnedBy);

const hasContext = Schema.is(WithContext);

/** Codex's models are via's own; every other owner is a provider. */
const ownerOf = (model: Model) => {
  const owner = isOwned(model) ? model.owned_by : "other";

  return owner === "openai" ? "Codex" : owner;
};

const contextOf = (model: Model) =>
  hasContext(model) ? `${Math.round(model.context_length / 1_000)}k context` : undefined;

function Models() {
  const models = useQuery(modelsQuery);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const list = models.data ?? [];
  const matches = list.filter((model) => model.id.toLowerCase().includes(query));
  const groups = Map.groupBy(matches, ownerOf);

  // Codex first, then providers by name.
  const owners = [...groups.keys()].toSorted((a, b) =>
    a === "Codex" ? -1 : b === "Codex" ? 1 : a.localeCompare(b),
  );

  return (
    <Page
      title="Models"
      description="What clients can ask for at /v1/models: Codex's models through the pool, and each provider's own."
    >
      {models.isPending ? (
        <div aria-busy="true" aria-label="Loading models" {...stylex.props(styles.grid)}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Skeleton key={index} height="44px" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<ModelsIcon size={18} />}
          title="No models to list"
          description="via lists Codex's models once an account is in the pool, and each configured provider's."
        />
      ) : (
        <>
          <div {...stylex.props(styles.search)}>
            <span aria-hidden="true" {...stylex.props(styles.searchIcon)}>
              <SearchIcon size={15} />
            </span>
            <Input
              type="search"
              aria-label="Search models"
              placeholder={`Search ${list.length} models`}
              value={search}
              onValueChange={setSearch}
            />
          </div>
          {owners.length === 0 ? (
            <output {...stylex.props(styles.none)}>No model matches “{search}”.</output>
          ) : (
            <div {...stylex.props(styles.groups)}>
              {owners.map((owner) => {
                const owned = groups.get(owner) ?? [];

                return (
                  <Section
                    key={owner}
                    title={owner}
                    aside={
                      <Badge color={owner === "Codex" ? "blue" : "gray"}>
                        {owned.length} {owned.length === 1 ? "model" : "models"}
                      </Badge>
                    }
                  >
                    <div {...stylex.props(styles.grid)}>
                      {owned.map((model) => (
                        <Panel key={model.id}>
                          <div {...stylex.props(styles.model)}>
                            <span {...stylex.props(styles.id)}>{model.id}</span>
                            {contextOf(model) !== undefined && (
                              <span {...stylex.props(styles.meta)}>{contextOf(model)}</span>
                            )}
                          </div>
                        </Panel>
                      ))}
                    </div>
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
