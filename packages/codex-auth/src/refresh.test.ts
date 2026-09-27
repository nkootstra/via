import { BunFileSystem } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  codexRefreshErrorFixture,
  issuedTokens,
  jwt,
  REFRESHED_EXP,
  refreshedTokens,
  withIssuer,
} from "./testing/index.ts";
import { AuthRequestError, CodexAuth, RefreshRejectedError, type Tokens } from "./index.ts";

const current: Tokens = {
  idToken: issuedTokens.id_token,
  accessToken: issuedTokens.access_token,
  refreshToken: "rt-1",
  expiresAt: 0,
};

describe("refresh", () => {
  it.effect("returns fresh tokens including the rotated refresh token", () =>
    withIssuer({}, () =>
      Effect.gen(function* () {
        expect(yield* (yield* CodexAuth).refresh(current)).toEqual({
          idToken: refreshedTokens.id_token,
          accessToken: refreshedTokens.access_token,
          refreshToken: "rt-2",
          expiresAt: REFRESHED_EXP * 1000,
        });
      }),
    ),
  );

  it.effect("keeps the current refresh and ID token when the issuer sends no new ones", () =>
    withIssuer(
      {
        refreshResponse: {
          status: 200,
          body: { access_token: refreshedTokens.access_token },
        },
      },
      () =>
        Effect.gen(function* () {
          const tokens = yield* (yield* CodexAuth).refresh(current);
          expect(tokens.refreshToken).toBe("rt-1");
          expect(tokens.idToken).toBe(issuedTokens.id_token);
          expect(tokens.accessToken).toBe(refreshedTokens.access_token);
        }),
    ),
  );

  for (const label of [
    "invalid_grant",
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
  ]) {
    it.effect(`rejects the account on codex's ${label} fixture, so it must log in again`, () =>
      Effect.gen(function* () {
        const refreshResponse = yield* codexRefreshErrorFixture(label);
        yield* withIssuer({ refreshResponse }, () =>
          Effect.gen(function* () {
            const error = yield* Effect.flip((yield* CodexAuth).refresh(current));
            expect(error).toEqual(new RefreshRejectedError({ code: label }));
          }),
        );
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );
  }

  it.effect("a refresh token works once: reusing it is rejected", () =>
    withIssuer({}, () =>
      Effect.gen(function* () {
        const auth = yield* CodexAuth;
        yield* auth.refresh(current);
        const error = yield* Effect.flip(auth.refresh(current));

        expect(error).toEqual(new RefreshRejectedError({ code: "refresh_token_reused" }));
        expect(error.message).toBe(
          "The refresh token was rejected (refresh_token_reused); log in to this account again",
        );
      }),
    ),
  );

  it.effect("a 400 without a rejection code is a failed request, not a dead account", () =>
    withIssuer({}, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          (yield* CodexAuth).refresh({ ...current, refreshToken: "rt-unknown" }),
        );

        expect(error).toEqual(new AuthRequestError({ reason: "token refresh returned HTTP 400" }));
      }),
    ),
  );

  it.effect("fails with AuthRequestError when the issuer is down", () =>
    withIssuer({ refreshResponse: { status: 503, body: {} } }, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* CodexAuth).refresh(current));
        expect(error).toEqual(new AuthRequestError({ reason: "token refresh returned HTTP 503" }));
      }),
    ),
  );

  it.effect("fails with AuthRequestError when the new access token carries no expiry", () =>
    withIssuer(
      { refreshResponse: { status: 200, body: { access_token: jwt({ sub: "no-exp" }) } } },
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* CodexAuth).refresh(current));
          expect(error).toBeInstanceOf(AuthRequestError);
        }),
    ),
  );

  it.effect("fails with AuthRequestError when the new access token is not a JWT", () =>
    withIssuer({ refreshResponse: { status: 200, body: { access_token: "opaque" } } }, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* CodexAuth).refresh(current));
        expect(error).toBeInstanceOf(AuthRequestError);
      }),
    ),
  );

  it.effect("fails with AuthRequestError when the refresh answer has no access token", () =>
    withIssuer({ refreshResponse: { status: 200, body: { id_token: "x" } } }, () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* CodexAuth).refresh(current));
        expect(error).toBeInstanceOf(AuthRequestError);
      }),
    ),
  );

  // The same codes in the error-object shape the issuer also uses.
  for (const [label, status, body] of [
    ["refresh_token_reused", 401, { error: { code: "refresh_token_reused", message: "reused" } }],
    [
      "refresh_token_expired",
      401,
      { error: { code: "refresh_token_expired", message: "expired" } },
    ],
  ] as const) {
    it.effect(`rejects the account on ${label} (HTTP ${status}), so it must log in again`, () =>
      withIssuer({ refreshResponse: { status, body } }, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* CodexAuth).refresh(current));
          expect(error).toEqual(new RefreshRejectedError({ code: label }));
        }),
      ),
    );
  }
});
