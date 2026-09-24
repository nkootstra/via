import { modelIds } from "@via/codex-upstream";
import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { authenticate, unauthenticated } from "./dispatch.ts";

/** GET /v1/models: the Codex models, and each with every effort suffix. */
export const models = Effect.gen(function* () {
  if (Option.isNone(yield* authenticate)) return unauthenticated();
  return HttpServerResponse.jsonUnsafe({
    object: "list",
    data: modelIds().map((id) => ({ id, object: "model", created: 0, owned_by: "openai" })),
  });
});
