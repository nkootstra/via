import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply } from "@via/providers/testing";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { ok, type Via, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

const range = "from=0&to=9007199254740991";

/** The admin API's JSON answer to `GET path`, once via has logged every request so far. */
const history = (via: Via, path: string) =>
  Effect.gen(function* () {
    yield* via.logged("Sent HTTP response");
    const response = yield* via.get(`/admin/history/${path}`, adminKey);
    expect(response.status).toBe(200);

    return yield* response.json;
  });

/**
 * Two Codex requests with the test key, then one to OpenRouter, which reports its
 * cost, a second apart: the test clock stands still unless it is moved.
 */
const traffic = (via: Via) =>
  Effect.gen(function* () {
    yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
    yield* TestClock.adjust("1 second");
    yield* via.post("/v1/responses", { model: "gpt-6-astra-high", input: "hi" });
    yield* TestClock.adjust("1 second");

    via.provider.respond(
      providerReply.json({
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.5 },
      }),
    );

    yield* (yield* via.post("/v1/chat/completions", {
      model: "openrouter/minimax-m3",
      messages: [],
    })).text;
    yield* via.logged("openrouter/minimax-m3");
  });

// $1,000 per million input tokens and $10,000 per million output tokens: 10 in and 2 out cost $0.03.
const prices = { "gpt-6-astra": { input: 1_000, output: 10_000 } };

layer(BunFileSystem.layer)("admin usage history", (it) => {
  it.effect("lists the requests, newest first, with their tokens", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* traffic(via);
          const page = yield* history(via, `requests?${range}&limit=2`);

          expect(page).toMatchObject({
            requests: [
              {
                model: "openrouter/minimax-m3",
                provider: "openrouter",
                costUsd: 0.5,
                accountId: null,
              },
              { model: "gpt-6-astra-high", provider: "codex", keyName: "test", inputTokens: 10 },
            ],
            next: { at: expect.any(Number), requestId: expect.any(String) },
          });
        }),
      { adminKey },
    ),
  );

  it.effect("filters the requests by model", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* traffic(via);
          const page = yield* history(via, `requests?${range}&model=gpt-6-astra`);

          expect(page).toMatchObject({ requests: [{ model: "gpt-6-astra" }], next: null });
        }),
      { adminKey },
    ),
  );

  it.effect("totals usage per model, priced at API rates or at what the upstream billed", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* traffic(via);
          const breakdown = yield* history(via, `breakdown?${range}&groupBy=provider`);

          expect(breakdown).toMatchObject({
            groups: [
              {
                group: "codex",
                label: "codex",
                requests: 2,
                inputTokens: 20,
                outputTokens: 4,
                cost: { apiEquivalentUsd: 0.06, billedUsd: 0, unpriced: [] },
              },
              {
                group: "openrouter",
                requests: 1,
                cost: { apiEquivalentUsd: 0, billedUsd: 0.5, unpriced: [] },
              },
            ],
            totals: {
              requests: 3,
              errors: 0,
              inputTokens: 27,
              cost: { apiEquivalentUsd: 0.06, billedUsd: 0.5, unpriced: [] },
            },
          });
        }),
      { adminKey, prices },
    ),
  );

  it.effect("narrows the totals and the series to one model, as it narrows the requests", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* traffic(via);
          const model = "model=openrouter/minimax-m3";
          const breakdown = yield* history(via, `breakdown?${range}&groupBy=provider&${model}`);

          const series = yield* history(
            via,
            `series?${range}&bucket=hour&tzOffsetMinutes=0&groupBy=model&${model}`,
          );

          expect(breakdown).toMatchObject({
            groups: [{ group: "openrouter", requests: 1 }],
            totals: { requests: 1 },
          });

          expect(series).toMatchObject({ points: [{ group: "openrouter/minimax-m3" }] });
        }),
      { adminKey },
    ),
  );

  it.effect("keeps only failed requests when asked, everywhere", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* traffic(via);
          const breakdown = yield* history(via, `breakdown?${range}&groupBy=model&outcome=error`);

          expect(breakdown).toMatchObject({ groups: [], totals: { requests: 0 } });
        }),
      { adminKey },
    ),
  );

  it.effect("names a key as it is called now", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
          yield* via.patch("/admin/keys/test", { name: "laptop" }, adminKey);
          const breakdown = yield* history(via, `breakdown?${range}&groupBy=key`);

          expect(breakdown).toMatchObject({ groups: [{ label: "laptop", requests: 1 }] });
        }),
      { adminKey },
    ),
  );

  it.effect("gives each group's tokens per hour", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* traffic(via);

          const series = yield* history(
            via,
            `series?${range}&bucket=hour&tzOffsetMinutes=0&groupBy=model`,
          );

          expect(series).toMatchObject({
            points: [
              { group: "gpt-6-astra", requests: 1, inputTokens: 10 },
              { group: "gpt-6-astra-high", requests: 1 },
              { group: "openrouter/minimax-m3", requests: 1, inputTokens: 7 },
            ],
          });
        }),
      { adminKey },
    ),
  );

  it.effect("deletes the whole history on request", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          yield* traffic(via);
          const deleted = yield* via.delete("/admin/history", adminKey);
          expect(deleted.status).toBe(200);
          expect(yield* deleted.json).toEqual({ deleted: 3 });

          const page = yield* via.get(`/admin/history/requests?${range}`, adminKey);
          expect(yield* page.json).toEqual({ requests: [], next: null });
        }),
      { adminKey },
    ),
  );

  it.effect("refuses a range it can't read", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get("/admin/history/requests?from=soon&to=1", adminKey);
          expect(response.status).toBe(400);
        }),
      { adminKey },
    ),
  );

  it.effect("needs the admin key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.get(`/admin/history/requests?${range}`, null);
          expect(response.status).toBe(401);
        }),
      { adminKey },
    ),
  );
});
