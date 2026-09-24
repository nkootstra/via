// Test-only: a local stand-in for auth.openai.com. Not exported from the package.
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { CLIENT_ID } from "./device-login.ts";

export const jwt = (payload: object) =>
  [{ alg: "RS256", typ: "JWT" }, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("signature")
    .join(".");

export const ACCESS_TOKEN_EXP = 2_000_000_000;

export const issuedTokens = {
  id_token: jwt({
    email: "dev@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acc-123", chatgpt_plan_type: "pro" },
  }),
  access_token: jwt({ exp: ACCESS_TOKEN_EXP }),
  refresh_token: "rt-1",
};

const badRequest = HttpServerResponse.jsonUnsafe({ error: "invalid_request" }, { status: 400 });

/** Serves the device-code endpoints. The user "approves" after `pendingPolls` polls; `Infinity` never approves. */
export const fakeIssuer = (options: { pendingPolls: number; interval: string }) => {
  let polls = 0;
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      "/api/accounts/deviceauth/usercode",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(
          Schema.Struct({ client_id: Schema.String }),
        );
        if (body.client_id !== CLIENT_ID) return badRequest;
        return HttpServerResponse.jsonUnsafe({
          device_auth_id: "dev-1",
          user_code: "ABCD-1234",
          interval: options.interval,
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/api/accounts/deviceauth/token",
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(
          Schema.Struct({ device_auth_id: Schema.String, user_code: Schema.String }),
        );
        if (body.device_auth_id !== "dev-1" || body.user_code !== "ABCD-1234") return badRequest;
        if (polls++ < options.pendingPolls) return HttpServerResponse.empty({ status: 403 });
        return HttpServerResponse.jsonUnsafe({
          authorization_code: "auth-code",
          code_challenge: "challenge",
          code_verifier: "verifier",
        });
      }),
    ),
    HttpRouter.add(
      "POST",
      "/oauth/token",
      Effect.gen(function* () {
        const issuer = yield* HttpServer.addressFormattedWith(Effect.succeed);
        const form = yield* HttpServerRequest.schemaBodyUrlParams(
          Schema.Struct({
            grant_type: Schema.Literal("authorization_code"),
            code: Schema.Literal("auth-code"),
            code_verifier: Schema.Literal("verifier"),
            client_id: Schema.Literal(CLIENT_ID),
            redirect_uri: Schema.String,
          }),
        );
        if (form.redirect_uri !== `${issuer}/deviceauth/callback`) return badRequest;
        return HttpServerResponse.jsonUnsafe(issuedTokens);
      }).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(badRequest))),
    ),
  );
  return HttpRouter.serve(routes).pipe(Layer.provideMerge(BunHttpServer.layer({ port: 0 })));
};
