import { type CatalogModel, resolveAlias } from "@via/codex-upstream";
import type { FallbackRule } from "@via/fallbacks";

/**
 * `target` for a request that asked for reasoning `effort`: a Codex model
 * that `catalog` lists with that effort gets it as its suffix; a provider's
 * model, one that already names an effort, or one without that effort is
 * used as written.
 */
const withEffort = (target: string, effort: string, catalog: ReadonlyArray<CatalogModel>) => {
  if (target.includes("/") || resolveAlias(target, catalog).effort !== undefined) return target;

  const listed = catalog.find(({ model }) => model === target);

  return listed?.efforts.includes(effort) === true ? `${target}-${effort}` : target;
};

/**
 * The models to try, in order, when `requested` can't serve: its own rule's,
 * as written, else, for a Codex model asked for with an effort suffix, its
 * base model's rule's, each keeping the effort where it has it. Never the
 * model asked for, nor one model twice; a fallback's own rule isn't followed.
 */
export const candidatesFor = (
  rules: ReadonlyArray<FallbackRule>,
  requested: string,
  catalog: ReadonlyArray<CatalogModel>,
): ReadonlyArray<string> => {
  const exact = rules.find(({ model }) => model === requested);

  if (exact !== undefined) return exact.fallbacks;

  if (requested.includes("/")) return [];

  const { model: base, effort } = resolveAlias(requested, catalog);
  const rule = rules.find(({ model }) => model === base);

  if (effort === undefined || rule === undefined) return [];

  const candidates = rule.fallbacks.map((target) => withEffort(target, effort, catalog));

  return [...new Set(candidates)].filter((candidate) => candidate !== requested);
};
