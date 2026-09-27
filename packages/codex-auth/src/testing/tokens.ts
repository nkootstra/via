import { writeJsonFile } from "@via/config";
import type { Schema } from "effect";
import { Account } from "../accounts.ts";
import type { Tokens } from "../codex-auth.ts";

/** An unsigned JWT carrying `payload`: via reads its claims, never checks its signature. */
export const jwt = (payload: Schema.JsonObject) =>
  [{ alg: "RS256", typ: "JWT" }, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("signature")
    .join(".");

/** An ID token for a ChatGPT identity, as auth.openai.com issues it; `extra` adds claims. */
export const idToken = (
  identity: { email: string; accountId: string; plan: string },
  extra: Schema.JsonObject = {},
) =>
  jwt({
    email: identity.email,
    "https://api.openai.com/auth": {
      chatgpt_account_id: identity.accountId,
      chatgpt_plan_type: identity.plan,
    },
    ...extra,
  });

/**
 * Tokens for a ChatGPT account named `name`: email `name@example.com`, account
 * `acc-name` on the pro plan, access token `at-name`, and the refresh token "rt-1"
 * the fake issuer accepts, valid far into the future unless `overrides` says otherwise.
 */
export const tokensFor = (name: string, overrides: Partial<Tokens> = {}): Tokens => ({
  idToken: idToken({ email: `${name}@example.com`, accountId: `acc-${name}`, plan: "pro" }),
  accessToken: `at-${name}`,
  refreshToken: "rt-1",
  expiresAt: 1e15,
  ...overrides,
});

/**
 * Writes account `name` into `authDir` as a login would have, with id and label
 * `name` and `tokensFor(name)`'s identity and tokens, unless `overrides` says otherwise.
 */
export const seedAccount = (authDir: string, name: string, overrides: Partial<Account> = {}) => {
  const tokens = tokensFor(name);

  return writeJsonFile(`${authDir}/${name}.json`, Account, {
    id: name,
    label: name,
    email: `${name}@example.com`,
    plan: "pro",
    accountId: `acc-${name}`,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    expiresAt: tokens.expiresAt,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
};
