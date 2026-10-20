/** The usage page's state, as its URL holds it. */
import { Schema } from "effect";

/**
 * An id a search param carries. TanStack Router reads a value that looks like a
 * number, as in `?key=123`, as one, so an id may arrive as either.
 */
const SearchId = Schema.Union([Schema.String, Schema.Finite]);

/**
 * The page's state, kept in the URL so it survives a reload and can be shared:
 * the tab, the range, what the usage is grouped by, the filters, and the
 * conversation open. A default is left out, so the plain page has a plain URL.
 */
export const UsageSearch = Schema.Struct({
  tab: Schema.optionalKey(Schema.Literals(["conversations"])),
  conversation: Schema.optionalKey(SearchId),
  range: Schema.optionalKey(Schema.Literals(["24h", "7d", "30d", "90d"])),
  by: Schema.optionalKey(Schema.Literals(["model", "account", "key"])),
  model: Schema.optionalKey(SearchId),
  account: Schema.optionalKey(SearchId),
  key: Schema.optionalKey(SearchId),
  failed: Schema.optionalKey(Schema.Boolean),
  fellBack: Schema.optionalKey(Schema.Boolean),
});

export type UsageSearch = typeof UsageSearch.Type;

/** A change to the search: a field set to undefined is taken out. */
export type SearchChange = { readonly [K in keyof UsageSearch]?: UsageSearch[K] | undefined };

/** The search with `change` made, and with its defaults and empty fields left out. */
export const changed = (search: UsageSearch, change: SearchChange): UsageSearch => {
  const next = { ...search, ...change };

  return {
    ...(next.tab !== undefined && { tab: next.tab }),
    ...(next.conversation !== undefined && { conversation: next.conversation }),
    ...(next.range !== undefined && next.range !== "24h" && { range: next.range }),
    ...(next.by !== undefined && next.by !== "model" && { by: next.by }),
    ...(next.model !== undefined && { model: next.model }),
    ...(next.account !== undefined && { account: next.account }),
    ...(next.key !== undefined && { key: next.key }),
    ...(next.failed === true && { failed: true }),
    ...(next.fellBack === true && { fellBack: true }),
  };
};
