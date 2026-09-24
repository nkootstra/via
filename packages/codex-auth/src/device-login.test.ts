import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpServer } from "effect/unstable/http";
import { ACCESS_TOKEN_EXP, fakeIssuer, issuedTokens } from "./fake-issuer.ts";
import { CodexAuth, DeviceLoginTimeoutError } from "./index.ts";

/** Runs `body` against a fresh fake issuer, with CodexAuth pointed at it. */
const withIssuer = <A, E>(
  options: { pendingPolls: number; interval: string },
  body: (issuer: string) => Effect.Effect<A, E, CodexAuth>,
) =>
  Effect.gen(function* () {
    const issuer = yield* HttpServer.addressFormattedWith(Effect.succeed);
    return yield* body(issuer).pipe(
      Effect.provide(CodexAuth.layer(issuer).pipe(Layer.provide(FetchHttpClient.layer))),
    );
  }).pipe(Effect.provide(fakeIssuer(options)));

describe("device login", () => {
  it.effect("returns the code the user enters at the verification URL", () =>
    withIssuer({ pendingPolls: 0, interval: "5" }, (issuer) =>
      Effect.gen(function* () {
        const code = yield* (yield* CodexAuth).requestDeviceCode;
        expect(code.userCode).toBe("ABCD-1234");
        expect(code.verificationUrl).toBe(`${issuer}/codex/device`);
      }),
    ),
  );

  it.effect("exchanges the code for tokens once the user approves", () =>
    withIssuer({ pendingPolls: 2, interval: "0" }, () =>
      Effect.gen(function* () {
        const auth = yield* CodexAuth;
        const tokens = yield* auth.awaitDeviceTokens(yield* auth.requestDeviceCode);
        expect(tokens).toEqual({
          idToken: issuedTokens.id_token,
          accessToken: issuedTokens.access_token,
          refreshToken: "rt-1",
          expiresAt: ACCESS_TOKEN_EXP * 1000,
        });
      }),
    ),
  );

  it.effect("gives up when the user does not approve within 15 minutes", () =>
    withIssuer({ pendingPolls: Infinity, interval: "5" }, () =>
      Effect.gen(function* () {
        const auth = yield* CodexAuth;
        const code = yield* auth.requestDeviceCode;
        const fiber = yield* Effect.forkChild(Effect.flip(auth.awaitDeviceTokens(code)));
        yield* TestClock.adjust("15 minutes");
        expect(yield* Fiber.join(fiber)).toBeInstanceOf(DeviceLoginTimeoutError);
      }),
    ),
  );
});
