/**
 * The admin state via sends whole: in a signed-in page's shell, and over
 * `/admin/events` whenever it changes. Either way it lands in the query cache,
 * under the keys of the queries that would otherwise fetch it.
 *
 * It is set query by query rather than hydrated: the payload is via's own
 * contract, `AdminState`, decoded by its schema, not TanStack's dehydrated
 * cache, so via needn't know how Query stores things, and one function serves
 * the shell and every event.
 */
import type { QueryClient } from "@tanstack/react-query";
import { AdminState } from "@via/server/admin-api";
import { Option, Schema } from "effect";
import {
  accountsQuery,
  fallbacksErrorQuery,
  fallbacksQuery,
  keysQuery,
  modelsQuery,
  ollamaQuery,
  opencodeGoQuery,
  openrouterQuery,
  poolQuery,
  sessionQuery,
  usageQuery,
} from "./admin.ts";

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(AdminState));

/** `json`, an admin state as via encodes it, decoded; none when it isn't one. */
export const parseState = (json: string) => decodeState(json);

/**
 * Puts `state` in the cache as fetched now: it is what via answers at this
 * moment, as fresh as a response the queries would get.
 */
export function applyState(queryClient: QueryClient, state: typeof AdminState.Type) {
  const at = { updatedAt: Date.now() };

  queryClient.setQueryData(sessionQuery.queryKey, state.session, at);
  queryClient.setQueryData(poolQuery.queryKey, state.pool, at);
  queryClient.setQueryData(usageQuery.queryKey, state.usage, at);
  queryClient.setQueryData(accountsQuery.queryKey, state.accounts, at);
  queryClient.setQueryData(opencodeGoQuery.queryKey, state.opencodeGo, at);
  queryClient.setQueryData(keysQuery.queryKey, state.keys, at);
  queryClient.setQueryData(modelsQuery.queryKey, state.models, at);
  queryClient.setQueryData(ollamaQuery.queryKey, state.ollama, at);
  queryClient.setQueryData(openrouterQuery.queryKey, state.openrouter, at);
  queryClient.setQueryData(fallbacksQuery.queryKey, state.fallbacks, at);
  queryClient.setQueryData(fallbacksErrorQuery.queryKey, state.fallbacksError, at);
}

/**
 * Fills `queryClient` from the state via put in the shell, when it did (for a
 * signed-in page), so the first render asks via for nothing. The element goes
 * once read: React renders the document, and it isn't part of the app.
 */
export function applyEmbeddedState(queryClient: QueryClient) {
  // The build prerenders the shell without a document, and without a state.
  if (!("document" in globalThis)) return;
  const element = document.getElementById("via-state");

  if (element === null) return;
  element.remove();

  Option.map(parseState(element.textContent ?? ""), (state) => applyState(queryClient, state));
}
