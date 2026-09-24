import { BunFileSystem } from "@effect/platform-bun";
import { completedStream, type RecordedRequest } from "@via/codex-upstream/testing";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { withVia } from "./harness.ts";

const ok = () => ({ status: 200, body: completedStream("hello") });
const accountOf = (request: RecordedRequest) => request.headers["chatgpt-account-id"];
const usageLimit = (resetsAt: number) => ({
  status: 429,
  body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: resetsAt } }),
});
const request = { model: "gpt-5.5", input: "hi" };

layer(BunFileSystem.layer)("POST /v1/responses", (it) => {
  it.effect("rejects a request without an API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", request, null);
        expect(response.status).toBe(401);
        expect(yield* response.json).toMatchObject({ error: { code: "invalid_api_key" } });
        expect(via.upstreamRequests).toHaveLength(0);
      }),
    ),
  );

  it.effect("rejects an unknown API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", request, "via_wrong");
        expect(response.status).toBe(401);
      }),
    ),
  );

  it.effect("streams the upstream events to a streaming client", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", { ...request, stream: true });
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        expect(yield* response.text).toBe(completedStream("hello"));
      }),
    ),
  );

  it.effect("answers a non-streaming client with the completed response as JSON", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.post("/v1/responses", request);
        expect(response.status).toBe(200);
        expect(yield* response.json).toMatchObject({ id: "resp_1", status: "completed" });
      }),
    ),
  );

  it.effect("uses the first account while it works", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.post("/v1/responses", request);
        expect(via.upstreamRequests[0]?.headers["chatgpt-account-id"]).toBe("acc-a");
      }),
    ),
  );

  it.effect(
    "moves on to the next account when one hits its usage limit, and lets it cool down",
    () =>
      withVia(
        (received) => (accountOf(received) === "acc-a" ? usageLimit(3600) : ok()),
        (via) =>
          Effect.gen(function* () {
            expect((yield* via.post("/v1/responses", request)).status).toBe(200);
            expect((yield* via.post("/v1/responses", request)).status).toBe(200);
            expect(via.upstreamRequests.map(accountOf)).toEqual(["acc-a", "acc-b", "acc-b"]);
          }),
      ),
  );

  it.effect("answers 429 with Retry-After when every account is cooling down", () =>
    withVia(
      () => ({ status: 429, headers: { "retry-after": "120" }, body: "" }),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", request);
          expect(response.status).toBe(429);
          expect(response.headers["retry-after"]).toBe("120");
          expect(yield* response.json).toMatchObject({ error: { code: "rate_limit_exceeded" } });
        }),
    ),
  );

  it.effect("returns a client error as-is, since another account would fail the same way", () =>
    withVia(
      () => ({ status: 400, body: JSON.stringify({ error: { message: "bad input" } }) }),
      (via) =>
        Effect.gen(function* () {
          const response = yield* via.post("/v1/responses", request);
          expect(response.status).toBe(400);
          expect(yield* response.json).toEqual({ error: { message: "bad input" } });
          expect(via.upstreamRequests).toHaveLength(1);
        }),
    ),
  );
});
