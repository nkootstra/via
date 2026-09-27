import { Effect, Layer, type Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { adminRoutes, type OpencodeGoEnvironment } from "./admin.ts";
import { chatCompletions } from "./chat-completions.ts";
import { ModelCatalog } from "./catalog.ts";
import { models } from "./models.ts";
import { logRequest } from "./request-log.ts";
import { responses } from "./responses.ts";
import { SessionBindings } from "./session-bindings.ts";
import { type EmbeddedUi, uiRoutes } from "./ui.ts";

export type { OpencodeGoEnvironment } from "./admin.ts";

export type { EmbeddedUi } from "./ui.ts";

/**
 * The OpenAI-compatible HTTP API of `via serve`, serving Codex requests from
 * the `AccountPool`. With `adminKey`, it also serves the admin API behind that key,
 * and with `ui` as well, the admin UI at `/ui`. `opencodeGoEnvironment` is
 * OpenCode Go's deprecated key variable, while it is set, which the admin API
 * notes on the account imported from it.
 */
export const ViaServer = {
  layer: (options: {
    readonly adminKey?: Redacted.Redacted<string> | undefined;
    readonly ui?: EmbeddedUi | undefined;
    readonly opencodeGoEnvironment?: OpencodeGoEnvironment | undefined;
  }) =>
    HttpRouter.serve(
      Layer.mergeAll(
        HttpRouter.add("POST", "/v1/responses", responses),
        HttpRouter.add("POST", "/v1/chat/completions", chatCompletions),
        HttpRouter.add("GET", "/v1/models", models),
        // For a host's health checks: needs no key, and isn't logged.
        HttpRouter.add("GET", "/healthz", Effect.succeed(HttpServerResponse.text("ok"))),
        adminRoutes(options.adminKey, options.opencodeGoEnvironment),
        // Like the admin API, the page for it is only there with the key.
        options.adminKey === undefined || options.ui === undefined
          ? Layer.empty
          : uiRoutes(options.ui),
      ),
      // One line per request from `logRequest`, instead of Effect's; `via serve`
      // announces the address itself.
      { disableLogger: true, disableListenLog: true, middleware: logRequest },
    ).pipe(Layer.provide(ModelCatalog.layer), Layer.provide(SessionBindings.layer)),
};
