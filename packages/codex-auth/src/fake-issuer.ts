// Test-only: a local stand-in for auth.openai.com, exported as `@via/codex-auth/testing`.
import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { CLIENT_ID, CodexAuth } from "./codex-auth.ts";

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

export const REFRESHED_EXP = 2_100_000_000;

export const refreshedTokens = {
  id_token: jwt({
    email: "dev@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acc-123", chatgpt_plan_type: "pro" },
    refreshed: true,
  }),
  access_token: jwt({ exp: REFRESHED_EXP }),
  refresh_token: "rt-2",
};

const badRequest = HttpServerResponse.jsonUnsafe({ error: "invalid_request" }, { status: 400 });

export type FakeIssuerOptions = {
  /** Polls answered with 403 before the user "approves"; `Infinity` never approves. */
  pendingPolls?: number;
  interval?: string;
  /** What the first refresh grant for "rt-1" answers with; reusing "rt-1" is rejected. */
  refreshResponse?: { status: number; body: object };
};

/** Serves the device-code and token endpoints of auth.openai.com. */
export const fakeIssuer = ({
  pendingPolls = 0,
  interval = "0",
  refreshResponse = { status: 200, body: refreshedTokens },
}: FakeIssuerOptions = {}) => {
  let polls = 0;
  let refreshTokenUsed = false;
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
          interval,
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
        if (polls++ < pendingPolls) return HttpServerResponse.empty({ status: 403 });
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
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers["content-type"]?.startsWith("application/json")) {
          yield* HttpServerRequest.schemaBodyJson(
            Schema.Struct({
              client_id: Schema.Literal(CLIENT_ID),
              grant_type: Schema.Literal("refresh_token"),
              refresh_token: Schema.Literal("rt-1"),
              scope: Schema.Literal("openid profile email"),
            }),
          );
          if (refreshTokenUsed) {
            return HttpServerResponse.jsonUnsafe(
              // The issuer's real answer, as codex's own tests record it.
              {
                error: "refresh_token_reused",
                error_description: "refresh token was already used",
              },
              { status: 400 },
            );
          }
          refreshTokenUsed = true;
          return HttpServerResponse.jsonUnsafe(refreshResponse.body, {
            status: refreshResponse.status,
          });
        }
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

/** Runs `body` against a fresh fake issuer, with CodexAuth pointed at it. */
export const withIssuer = <A, E, R>(
  options: FakeIssuerOptions,
  body: (issuer: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const issuer = yield* HttpServer.addressFormattedWith(Effect.succeed);
    return yield* body(issuer).pipe(
      Effect.provide(CodexAuth.layer(issuer).pipe(Layer.provide(FetchHttpClient.layer))),
    );
  }).pipe(Effect.provide(fakeIssuer(options)));
