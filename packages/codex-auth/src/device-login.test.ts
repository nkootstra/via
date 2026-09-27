import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { ACCESS_TOKEN_EXP, issuedTokens, withIssuer } from "./testing/index.ts";
import { AuthRequestError, CodexAuth, type DeviceCode, DeviceLoginTimeoutError } from "./index.ts";

/** Runs `body` with CodexAuth pointed at `issuer` instead of the fake's own address. */
const pointedAt =
  (issuer: string) =>
  <A, E>(body: Effect.Effect<A, E, CodexAuth>) =>
    body.pipe(Effect.provide(CodexAuth.layer(issuer).pipe(Layer.provide(FetchHttpClient.layer))));

// Nothing listens on port 0, so every request fails before reaching an issuer.
const unreachable = "http://127.0.0.1:0";

const deviceCode: DeviceCode = {
  deviceAuthId: "dev-1",
  userCode: "ABCD-1234",
  verificationUrl: "https://auth.example/codex/device",
  intervalSeconds: 0,
};

describe("device login", () => {
  it.effect("returns the code the user enters at the verification URL", () =>
    withIssuer({ interval: "5" }, (issuer) =>
      Effect.gen(function* () {
        const code = yield* (yield* CodexAuth).requestDeviceCode;
        expect(code.userCode).toBe("ABCD-1234");
        expect(code.verificationUrl).toBe(`${issuer}/codex/device`);
      }),
    ),
  );

  it.effect("exchanges the code for tokens once the user approves", () =>
    withIssuer({ pendingPolls: 2 }, () =>
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
        const error = yield* Fiber.join(fiber);
        expect(error).toBeInstanceOf(DeviceLoginTimeoutError);
        expect(error.message).toBe("Device login was not approved within 15m");
      }),
    ),
  );

  it.effect("fails with AuthRequestError when the issuer hands out no device code", () =>
    withIssuer({}, (issuer) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* CodexAuth).requestDeviceCode);
        expect(error).toBeInstanceOf(AuthRequestError);
        expect(error.message).toMatch(/^OpenAI auth request failed: /);
      }).pipe(pointedAt(`${issuer}/elsewhere`)),
    ),
  );

  it.effect("fails with AuthRequestError when a poll gets an answer other than approval", () =>
    withIssuer({}, () =>
      Effect.gen(function* () {
        const unknownCode = { ...deviceCode, deviceAuthId: "unknown" };
        const error = yield* Effect.flip((yield* CodexAuth).awaitDeviceTokens(unknownCode));

        expect(error).toEqual(
          new AuthRequestError({ reason: "device token poll returned HTTP 400" }),
        );
      }),
    ),
  );

  it.effect("fails with AuthRequestError when the issuer is unreachable while polling", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* CodexAuth).awaitDeviceTokens(deviceCode));
      expect(error).toBeInstanceOf(AuthRequestError);
    }).pipe(pointedAt(unreachable)),
  );
});
