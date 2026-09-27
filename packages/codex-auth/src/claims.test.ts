import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { jwt } from "./fake-issuer.ts";
import { decodeIdToken, InvalidIdTokenError } from "./claims.ts";

describe("decodeIdToken", () => {
  it.effect("extracts email, ChatGPT account id and plan", () =>
    Effect.gen(function* () {
      const token = jwt({
        email: "dev@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acc-123",
          chatgpt_plan_type: "pro",
        },
      });

      expect(yield* decodeIdToken(token)).toEqual({
        email: "dev@example.com",
        accountId: "acc-123",
        plan: "pro",
      });
    }),
  );

  it.effect("rejects a token without the OpenAI auth claim", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeIdToken(jwt({ email: "dev@example.com" })));
      expect(error).toBeInstanceOf(InvalidIdTokenError);
    }),
  );

  it.effect("rejects a string that is not a JWT", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(decodeIdToken("not-a-jwt"));
      expect(error).toBeInstanceOf(InvalidIdTokenError);
    }),
  );
});
