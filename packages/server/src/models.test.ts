import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream, startFakeCodex } from "@via/codex-upstream/testing";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { withVia } from "./harness.ts";

const ok = () => ({ status: 200, body: completedStream("hello") });

const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const ids = (list: unknown) =>
  Schema.decodeUnknownSync(ModelList)(list).data.map((model) => model.id);

const catalog = {
  models: [
    {
      slug: "gpt-7",
      visibility: "list",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    },
  ],
};

layer(BunFileSystem.layer)("GET /v1/models", (it) => {
  it.effect("lists the models Codex offers the first account, with their effort aliases", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.get("/v1/models");
            expect(ids(yield* response.json)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
            expect(codex.requests.at(-1)?.headers["chatgpt-account-id"]).toBe("acc-a");
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("skips an account whose refresh token is rejected and asks the next", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            const response = yield* via.get("/v1/models");
            expect(ids(yield* response.json)).toEqual(["gpt-7", "gpt-7-low", "gpt-7-high"]);
            expect(codex.requests.map((request) => request.headers["chatgpt-account-id"])).toEqual([
              "acc-b",
            ]);
          }),
        {
          codexUrl: codex.url,
          refreshResponse: { status: 400, body: { error: "invalid_grant" } },
          aExpiresAt: 0,
        },
      );
    }),
  );

  it.effect("asks Codex again only once the listed catalog is five minutes old", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models(catalog);
      yield* withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            yield* via.get("/v1/models");
            yield* via.get("/v1/models");
            expect(codex.requests).toHaveLength(1);
            yield* TestClock.adjust("5 minutes");
            yield* via.get("/v1/models");
            expect(codex.requests).toHaveLength(2);
          }),
        { codexUrl: codex.url },
      );
    }),
  );

  it.effect("falls back to the bundled models when Codex does not list any", () =>
    withVia(ok, (via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/v1/models");
        expect(response.status).toBe(200);
        const list = yield* response.json;
        expect(list).toMatchObject({ object: "list" });
        expect(list).toHaveProperty(
          "data",
          expect.arrayContaining([
            {
              id: "gpt-6-astra",
              object: "model",
              created: 0,
              owned_by: "openai",
            },
            {
              id: "gpt-6-astra-high",
              object: "model",
              created: 0,
              owned_by: "openai",
            },
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
