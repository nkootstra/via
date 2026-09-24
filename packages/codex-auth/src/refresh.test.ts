import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { issuedTokens, REFRESHED_EXP, refreshedTokens, withIssuer } from "./fake-issuer.ts";
import { CodexAuth, RefreshRejectedError, type Tokens } from "./index.ts";

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

  // The first four are verbatim from codex's refresh tests (see
  // @via/codex-upstream's fixtures/refresh-errors.json): what the issuer sends.
  for (const [label, status, body] of [
    ["invalid_grant", 400, { error: "invalid_grant", error_description: "refresh token expired" }],
    [
      "refresh_token_expired",
      400,
      { error: "refresh_token_expired", error_description: "refresh token has expired" },
    ],
    [
      "refresh_token_reused",
      400,
      { error: "refresh_token_reused", error_description: "refresh token was already used" },
    ],
    [
      "refresh_token_invalidated",
      400,
      { error: "refresh_token_invalidated", error_description: "refresh token was revoked" },
    ],
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
