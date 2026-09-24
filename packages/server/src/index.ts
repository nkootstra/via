import { HttpRouter } from "effect/unstable/http";
import { responses } from "./responses.ts";

/** The OpenAI-compatible HTTP API of `via serve`. */
export const ViaServer = {
  layer: HttpRouter.serve(HttpRouter.add("POST", "/v1/responses", responses)),
};
