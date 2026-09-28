import { BunHttpServer } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { issuedTokens } from "./testing/index.ts";
import { AuthRequestError, CodexAuth, type DeviceCode, type Tokens } from "./index.ts";

/**
 * An issuer that answers the paths in `answers` with their JSON, and takes every
 * other request without ever answering it; `arrived` waits for the first of those.
 */
const startSilentIssuer = (answers: Readonly<Record<string, object>> = {}) =>
  Effect.gen(function* () {
    const arrived = yield* Deferred.make<void>();

    const answer = Effect.gen(function* () {
      const { url } = yield* HttpServerRequest.HttpServerRequest;
      const known = answers[new URL(url, "http://issuer").pathname];

      if (known !== undefined) return HttpServerResponse.jsonUnsafe(known);
      yield* Deferred.succeed(arrived, undefined);

      return yield* Effect.never;
    });

    const server = yield* Layer.build(
      HttpRouter.serve(HttpRouter.add("*", "*", answer)).pipe(
        Layer.provideMerge(BunHttpServer.layer({ port: 0, idleTimeout: 0 })),
      ),
    );

    const url = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(server));

    return { url, arrived: Deferred.await(arrived) };
  });

const code: DeviceCode = {
  deviceAuthId: "dev-1",
  userCode: "ABCD-1234",
  verificationUrl: "https://issuer/codex/device",
  intervalSeconds: 5,
};

const current: Tokens = {
  idToken: issuedTokens.id_token,
  accessToken: issuedTokens.access_token,
  refreshToken: "rt-1",
  expiresAt: 0,
};

const approved = {
  "/api/accounts/deviceauth/token": { authorization_code: "ac-1", code_verifier: "cv-1" },
};

describe("CodexAuth against an issuer that never answers", () => {
  type Call = (auth: CodexAuth["Service"]) => Effect.Effect<unknown, { message: string }>;

  const cases: ReadonlyArray<readonly [string, Readonly<Record<string, object>>, Call]> = [
    ["asking for a device code", {}, (auth) => auth.requestDeviceCode],
    ["exchanging an approved code", approved, (auth) => auth.awaitDeviceTokens(code)],
    ["refreshing tokens", {}, (auth) => auth.refresh(current)],
  ];

  for (const [what, answers, call] of cases) {
    it.effect(`gives up ${what} after 30 seconds`, () =>
      Effect.gen(function* () {
        const issuer = yield* startSilentIssuer(answers);

        const failing = yield* Effect.flatMap(CodexAuth, (auth) => Effect.flip(call(auth))).pipe(
          Effect.provide(CodexAuth.layer(issuer.url).pipe(Layer.provide(FetchHttpClient.layer))),
          Effect.forkChild,
        );

        yield* issuer.arrived;
        yield* TestClock.adjust("30 seconds");
        const error = yield* Fiber.join(failing);
        expect(error).toBeInstanceOf(AuthRequestError);
        expect(error.message).toContain("no answer within 30s");
      }),
    );
  }
});
