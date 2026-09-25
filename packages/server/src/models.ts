import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { ModelCatalog } from "./catalog.ts";
import { authenticated } from "./dispatch.ts";

/** GET /v1/models: the Codex models, each with every effort suffix, then the providers'. */
export const models = authenticated(
  Effect.gen(function* () {
    return HttpServerResponse.jsonUnsafe({
      object: "list",
      data: yield* (yield* ModelCatalog).list,
    });
  }),
);
