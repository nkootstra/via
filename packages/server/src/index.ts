import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { chatCompletions } from "./chat-completions.ts";
import { PoolStates } from "./dispatch.ts";
import { responses } from "./responses.ts";

/** The OpenAI-compatible HTTP API of `via serve`. */
export const ViaServer = {
  layer: HttpRouter.serve(
    Layer.mergeAll(
      HttpRouter.add("POST", "/v1/responses", responses),
      HttpRouter.add("POST", "/v1/chat/completions", chatCompletions),
    ),
  ).pipe(Layer.provide(PoolStates.layer)),
};
