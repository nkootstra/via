import { Schema } from "effect";
import { resolveAlias } from "./models.ts";

/** A Responses API request body; only the fields via rewrites are known. */
export type ResponsesBody = Schema.JsonObject;

// The Codex backend rejects these with "Unsupported parameter: <name>".
const UNSUPPORTED = ["max_output_tokens", "temperature", "top_p", "previous_response_id"];

const ENCRYPTED_REASONING = "reasoning.encrypted_content";

const isList = Schema.is(Schema.Array(Schema.Json));

const isModel = Schema.is(Schema.String);

const isObject = Schema.is(Schema.JsonObject);

/** Rewrites a client's Responses request into one the Codex backend accepts. */
export const prepareBody = (body: ResponsesBody) => {
  const include = isList(body.include) ? body.include : [];
  const alias = isModel(body.model) ? resolveAlias(body.model) : undefined;

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
