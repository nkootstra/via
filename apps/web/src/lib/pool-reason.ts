import { providerWindowName } from "./time.ts";

const signedOut = "ChatGPT signed this account out";

/** The codes via keeps for why the pool set an account aside, from Codex, OpenCode Go or via. */
const reasons: ReadonlyMap<string, string> = new Map([
  ["rate_limited", "Rate limited"],
  ["rate_limit_exceeded", "Rate limited"],
  ["usage_exhausted", "Usage limit reached"],
  ["usage_limit_reached", "Usage limit reached"],
  ["organization_usage_limit_exceeded", "Usage limit reached"],
  ["insufficient_quota", "Out of quota"],
  ["credit_balance_exhausted", "Out of credits"],
  ["organization_spend_limit_exceeded", "Spend limit reached"],
  ["project_spend_limit_exceeded", "Spend limit reached"],
  ["usage_not_included", "Codex isn't included in this plan"],
  ["forbidden", "ChatGPT refused this account"],
  ["auth_unavailable", "ChatGPT's sign-in server didn't answer"],
  ["token_unavailable", "via couldn't read this account's tokens"],
  ["unauthorized", signedOut],
  ["invalid_grant", signedOut],
  ["refresh_token_expired", signedOut],
  ["refresh_token_reused", signedOut],
  ["refresh_token_invalidated", signedOut],
]);

const CODE = /^[a-z0-9_]+$/;

const EXHAUSTED = /^(\w+)_exhausted$/;

/**
 * Why the pool set an account aside, in words: via keeps a code, such as
 * `usage_limit_reached` or OpenCode Go's `weekly_exhausted`. A code it doesn't
 * know is spelled out; a reason that is already words is left as it is.
 */
export const poolReason = (reason: string) => {
  const known = reasons.get(reason);

  if (known !== undefined) return known;

  const window = EXHAUSTED.exec(reason)?.[1];

  if (window !== undefined) return `${providerWindowName(window)} limit used up`;

  if (!CODE.test(reason)) return reason;

  const words = reason.replaceAll("_", " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
};
