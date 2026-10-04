import { Schema } from "effect";
import { type CatalogModel, resolveAlias } from "./models.ts";

/** A Responses API request body; only the fields via rewrites are known. */
export type ResponsesBody = Schema.JsonObject;

// The Codex backend rejects these with "Unsupported parameter: <name>". Clients and SDKs
// send them by default, so they're dropped rather than turned into a 400.
const UNSUPPORTED = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "previous_response_id",
  "user",
  "metadata",
  "context_management",
];

const ENCRYPTED_REASONING = "reasoning.encrypted_content";

const isList = Schema.is(Schema.Array(Schema.Json));

const isModel = Schema.is(Schema.String);

const isObject = Schema.is(Schema.JsonObject);

/**
 * Rewrites a client's Responses request into one the Codex backend accepts,
 * resolving effort aliases against the models `catalog` lists.
 */
export const prepareBody = (body: ResponsesBody, catalog?: ReadonlyArray<CatalogModel>) => {
  const include = isList(body.include) ? body.include : [];
  const alias = isModel(body.model) ? resolveAlias(body.model, catalog) : undefined;

  return {
    ...Object.fromEntries(Object.entries(body).filter(([key]) => !UNSUPPORTED.includes(key))),
    instructions: body.instructions ?? "",
    stream: true,
    store: false,
    include: include.includes(ENCRYPTED_REASONING) ? include : [...include, ENCRYPTED_REASONING],
    ...(alias?.effort !== undefined && {
      model: alias.model,
      reasoning: { ...(isObject(body.reasoning) ? body.reasoning : {}), effort: alias.effort },
    }),
  };
};
