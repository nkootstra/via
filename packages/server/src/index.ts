import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { PoolStates, responses } from "./responses.ts";

/** The OpenAI-compatible HTTP API of `via serve`. */
export const ViaServer = {
  layer: HttpRouter.serve(HttpRouter.add("POST", "/v1/responses", responses)).pipe(
    Layer.provide(PoolStates.layer),
  ),
};
