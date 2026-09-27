import { Effect, Layer, type Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { adminRoutes } from "./admin.ts";
import { chatCompletions } from "./chat-completions.ts";
import { ModelCatalog } from "./catalog.ts";
import { models } from "./models.ts";
import { logRequest } from "./request-log.ts";
import { responses } from "./responses.ts";
import { SessionBindings } from "./session-bindings.ts";

/**
 * The OpenAI-compatible HTTP API of `via serve`, serving Codex requests from
 * the `AccountPool`. With `adminKey`, it also serves the admin API behind that key.
 */
export const ViaServer = {
  layer: (options: { readonly adminKey?: Redacted.Redacted<string> | undefined }) =>
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/v1/responses", responses),
        HttpRouter.add("POST", "/v1/chat/completions", chatCompletions),
        HttpRouter.add("GET", "/v1/models", models),
        // For a host's health checks: needs no key, and isn't logged.
        HttpRouter.add("GET", "/healthz", Effect.succeed(HttpServerResponse.text("ok"))),
        adminRoutes(options.adminKey),
      ),
      // One line per request from `logRequest`, instead of Effect's; `via serve`
      // announces the address itself.
      { disableLogger: true, disableListenLog: true, middleware: logRequest },
    ).pipe(Layer.provide(ModelCatalog.layer), Layer.provide(SessionBindings.layer)),
};
