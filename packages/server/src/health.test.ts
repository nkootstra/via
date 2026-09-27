import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { ok, withVia } from "./harness.ts";

layer(BunFileSystem.layer)("GET /healthz", (it) => {
  it.effect("answers a health check without a key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/healthz", null);
        expect(response.status).toBe(200);
      }),
    ),
  );

  it.effect("gets a request ID too, even though it isn't logged", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/healthz", null);
        expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      }),
    ),
  );

  it.effect("leaves health checks out of the request log", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        yield* via.get("/healthz", null);
        yield* via.get("/v1/models", null);
        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          "http.url": "/v1/models",
        });
      }),
    ),
  );
});
