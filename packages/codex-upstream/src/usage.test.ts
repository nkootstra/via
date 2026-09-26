import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { CodexUpstream } from "./index.ts";
import { startFakeCodex, usagePayload } from "./testing/index.ts";

const account = { accessToken: "at-1", accountId: "acc-1" };

/** Asks a fake Codex, answering with `body` and `status`, for the account's usage. */
const usage = (body: object, status = 200) =>
  Effect.gen(function* () {
    const codex = yield* startFakeCodex;
    codex.usage(account.accountId, body, status);
    const result = yield* Effect.gen(function* () {
      return yield* (yield* CodexUpstream).usage(account);
    }).pipe(
      Effect.provide(
        CodexUpstream.layer({ baseUrl: codex.url, cloak: true, version: "0.0.0" }).pipe(
          Layer.provide(FetchHttpClient.layer),
        ),
      ),
      Effect.result,
    );
    return { result, request: codex.requests[0]! };
  });

describe("CodexUpstream.usage", () => {
  it.effect("reads the account's rate limit windows", () =>
    Effect.gen(function* () {
      const { result, request } = yield* usage(usagePayload);
      expect(request.headers).toMatchObject({
        authorization: "Bearer at-1",
        "chatgpt-account-id": "acc-1",
      });
      expect(result).toMatchObject({
        success: [
          { windowMinutes: 300, usedPercent: 12, resetsAt: 1_700_003_600_000 },
          { windowMinutes: 10_080, usedPercent: 40, resetsAt: 1_700_086_400_000 },
        ],
      });
    }),
  );

  it.effect("skips windows the plan does not have", () =>
    Effect.gen(function* () {
      const { result } = yield* usage({
        ...usagePayload,
        rate_limit: { ...usagePayload.rate_limit, secondary_window: null },
      });
      expect(result).toMatchObject({ success: [{ windowMinutes: 300 }] });
    }),
  );

  it.effect("fails with the status when the backend refuses", () =>
    Effect.gen(function* () {
      const { result } = yield* usage({}, 401);
      expect(result).toMatchObject({ failure: { _tag: "UsageUnavailableError", status: 401 } });
    }),
  );
});
