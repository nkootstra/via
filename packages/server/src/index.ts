import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { chatCompletions } from "./chat-completions.ts";
import { ModelCatalog } from "./catalog.ts";
import { models } from "./models.ts";
import { responses } from "./responses.ts";

/** The OpenAI-compatible HTTP API of `via serve`, keeping account states in `PoolStates`. */
export const ViaServer = {
  layer: HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add("POST", "/v1/responses", responses),
      HttpRouter.add("POST", "/v1/chat/completions", chatCompletions),
      HttpRouter.add("GET", "/v1/models", models),
    ),
  ).pipe(Layer.provide(ModelCatalog.layer)),
};
