import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ACCESS_TOKEN_EXP, issuedTokens, withIssuer } from "./fake-issuer.ts";
import { CodexAuth, DeviceLoginTimeoutError } from "./index.ts";

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
        expect(yield* Fiber.join(fiber)).toBeInstanceOf(DeviceLoginTimeoutError);
      }),
    ),
  );
});
