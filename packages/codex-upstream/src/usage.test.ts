import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  completedStream,
  type FakeReply,
  fakeUpstream,
  type RecordedRequest,
  upstreamUrl,
  usagePayload,
} from "./fake-upstream.ts";
import { CodexUpstream } from "./index.ts";

const account = { accessToken: "at-1", accountId: "acc-1" };

/** Asks the fake upstream, answering with `reply`, for the account's usage. */
const usage = (reply: FakeReply) =>
  Effect.gen(function* () {
    const received: Array<RecordedRequest> = [];
    const result = yield* Effect.gen(function* () {
      const baseUrl = yield* upstreamUrl;
      return yield* Effect.gen(function* () {
        return yield* (yield* CodexUpstream).usage(account);
      }).pipe(
        Effect.provide(
          CodexUpstream.layer({ baseUrl, cloak: true }).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
        Effect.result,
      );
    }).pipe(
      Effect.provide(
        fakeUpstream(
          () => ({ status: 200, body: completedStream("hello") }),
          (request) => {
            received.push(request);
            return reply;
          },
        ),
      ),
    );
    return { result, request: received[0]! };
  });

describe("CodexUpstream.usage", () => {
  it.effect("reads the account's rate limit windows", () =>
    Effect.gen(function* () {
      const { result, request } = yield* usage({
        status: 200,
        body: JSON.stringify(usagePayload),
      });
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
        status: 200,
        body: JSON.stringify({
          ...usagePayload,
          rate_limit: { ...usagePayload.rate_limit, secondary_window: null },
        }),
      });
      expect(result).toMatchObject({ success: [{ windowMinutes: 300 }] });
    }),
  );

  it.effect("fails with the status when the backend refuses", () =>
    Effect.gen(function* () {
      const { result } = yield* usage({ status: 401, body: "{}" });
      expect(result).toMatchObject({ failure: { _tag: "UsageUnavailableError", status: 401 } });
    }),
  );
});
