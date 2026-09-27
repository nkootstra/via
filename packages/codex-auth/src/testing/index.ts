// Test-only: fakes and fixtures for auth.openai.com, exported as `@via/codex-auth/testing`.
export {
  ACCESS_TOKEN_EXP,
  type FakeIssuerOptions,
  issuedTokens,
  REFRESHED_EXP,
  refreshedTokens,
  startFakeIssuer,
  withIssuer,
} from "./fake-issuer.ts";

export { codexRefreshErrorFixture } from "./fixtures.ts";

export { idToken, jwt, seedAccount, tokensFor } from "./tokens.ts";
