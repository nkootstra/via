import type { SearchSelect } from "@via/ui";
import type { ComponentProps } from "react";
import type { ModelEntry } from "../lib/model-entries.ts";
import { providerName } from "../lib/provider-name.ts";
import { CodexIcon, ProviderLogo } from "./icons.tsx";

type Groups = ComponentProps<typeof SearchSelect>["groups"];

/**
 * The models to pick from, as the Models page lists them: grouped by who
 * serves them, Codex first, then providers by name, each named without its
 * prefix and found by any id it goes by. A model `exclude` holds is left out;
 * one `unavailable` gives a reason for can't be picked, and says why.
 */
export const modelGroups = (
  entries: ReadonlyArray<ModelEntry>,
  {
    exclude = new Set(),
    unavailable = () => undefined,
  }: {
    readonly exclude?: ReadonlySet<string>;
    readonly unavailable?: (id: string) => string | undefined;
  } = {},
): Groups => {
  const shown = entries.filter((entry) => !exclude.has(entry.model.id));
  const owners = Map.groupBy(shown, (entry) => entry.owner);

  return [...owners.keys()]
    .toSorted((a, b) => (a === "Codex" ? -1 : b === "Codex" ? 1 : a.localeCompare(b)))
    .map((owner) => ({
      label: providerName(owner),
      icon: owner === "Codex" ? <CodexIcon size={14} /> : <ProviderLogo name={owner} size={14} />,
      options: (owners.get(owner) ?? []).map(({ model, name, efforts, ids }) => {
        const why = unavailable(model.id);
        const detail = why ?? (efforts.length > 0 ? efforts.join(" · ") : undefined);

        return {
          value: model.id,
          label: name,
          keywords: ids,
          ...(detail !== undefined && { detail }),
          ...(why !== undefined && { disabled: true }),
        };
      }),
    }));
};
