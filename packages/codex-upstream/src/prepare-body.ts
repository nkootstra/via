import { resolveAlias } from "./models.ts";

/** A Responses API request body; only the fields via rewrites are known. */
export type ResponsesBody = Readonly<Record<string, unknown>>;

// The Codex backend rejects these with "Unsupported parameter: <name>".
const UNSUPPORTED = ["max_output_tokens", "temperature", "top_p", "previous_response_id"];

const ENCRYPTED_REASONING = "reasoning.encrypted_content";

/** Rewrites a client's Responses request into one the Codex backend accepts. */
export const prepareBody = (body: ResponsesBody): Record<string, unknown> => {
  const include = Array.isArray(body.include) ? body.include : [];
  const alias = typeof body.model === "string" ? resolveAlias(body.model) : undefined;

  return {
    ...Object.fromEntries(Object.entries(body).filter(([key]) => !UNSUPPORTED.includes(key))),
    instructions: body.instructions ?? "",
    stream: true,
    store: false,
    include: include.includes(ENCRYPTED_REASONING) ? include : [...include, ENCRYPTED_REASONING],
    ...(alias?.effort !== undefined && {
      model: alias.model,
      reasoning: {
        ...(typeof body.reasoning === "object" && body.reasoning),
        effort: alias.effort,
      },
    }),
  };
};
