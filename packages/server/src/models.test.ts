import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { withVia } from "./harness.ts";

const ok = () => ({ status: 200, body: completedStream("hello") });

layer(BunFileSystem.layer)("GET /v1/models", (it) => {
  it.effect("lists the Codex models and their effort suffix aliases", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/v1/models");
        expect(response.status).toBe(200);
        const list = yield* response.json;
        expect(list).toMatchObject({ object: "list" });
        expect(list).toHaveProperty(
          "data",
          expect.arrayContaining([
            { id: "gpt-6-astra", object: "model", created: 0, owned_by: "openai" },
            { id: "gpt-6-astra-high", object: "model", created: 0, owned_by: "openai" },
          ]),
        );
      }),
    ),
  );

  it.effect("rejects a request without an API key", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/v1/models", null);
        expect(response.status).toBe(401);
      }),
    ),
  );
});
