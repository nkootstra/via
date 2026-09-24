import { BunFileSystem } from "@effect/platform-bun";
import { completedStream } from "@via/codex-upstream/testing";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { withVia } from "./harness.ts";

const ok = () => ({ status: 200, body: completedStream("hello") });
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
});
