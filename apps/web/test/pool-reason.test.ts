import { describe, expect, it } from "vitest";
import { poolReason } from "../src/lib/pool-reason.ts";

describe("poolReason", () => {
  it("names a limit Codex reports by its code", () => {
    expect(poolReason("usage_limit_reached")).toBe("Usage limit reached");
    expect(poolReason("rate_limited")).toBe("Rate limited");
  });

  it("names a used-up OpenCode Go window as the overview names it", () => {
    expect(poolReason("rolling_exhausted")).toBe("5 hours limit used up");
    expect(poolReason("weekly_exhausted")).toBe("Weekly limit used up");
  });

  it("says ChatGPT signed an account out for any refused refresh", () => {
    expect(poolReason("invalid_grant")).toBe("ChatGPT signed this account out");
    expect(poolReason("refresh_token_reused")).toBe("ChatGPT signed this account out");
    expect(poolReason("unauthorized")).toBe("ChatGPT signed this account out");
  });

  it("says what via couldn't do for a sign-in hiccup", () => {
    expect(poolReason("auth_unavailable")).toBe("ChatGPT's sign-in server didn't answer");
    expect(poolReason("token_unavailable")).toBe("via couldn't read this account's tokens");
  });

  it("spells out a code it doesn't know rather than showing it raw", () => {
    expect(poolReason("account_deactivated")).toBe("Account deactivated");
    expect(poolReason("upstream_503")).toBe("Upstream 503");
  });

  it("leaves a reason that is already words as it is", () => {
    expect(poolReason("you@home.example was signed out")).toBe("you@home.example was signed out");
  });
});
