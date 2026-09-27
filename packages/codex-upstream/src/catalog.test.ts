import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { CodexUpstream, modelIds, ModelsUnavailableError } from "./index.ts";
import { startFakeCodex } from "./testing/fake-codex.ts";

const account = { accessToken: "at-1", accountId: "acc-1" };

const models = (url: string) =>
  Effect.flatMap(CodexUpstream, (codex) => codex.models(account)).pipe(
    Effect.provide(
      CodexUpstream.layer({ baseUrl: url, cloak: true, version: "0.0.0" }).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
  );

const level = (effort: string) => ({ effort, description: `${effort} effort` });

layer(BunFileSystem.layer)("CodexUpstream.models", (it) => {
  it.effect("lists the account's pickable models with their reasoning efforts", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models({
        models: [
          {
            slug: "gpt-6-sol",
            display_name: "GPT-6 Sol",
            visibility: "list",
            supported_reasoning_levels: [level("low"), level("high")],
          },
          { slug: "codex-auto-review", visibility: "hide", supported_reasoning_levels: [] },
          { slug: "gpt-6-luna", visibility: "list" },
        ],
      });
      expect(yield* models(codex.url)).toEqual([
        { model: "gpt-6-sol", efforts: ["low", "high"] },
        { model: "gpt-6-luna", efforts: [] },
      ]);
    }),
  );

  it.effect("gets the bundled models from a fake Codex whose catalog is not scripted", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      expect(modelIds(yield* models(codex.url))).toEqual(modelIds());
    }),
  );

  it.effect("asks as the account, naming the Codex version it presents", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      codex.models({ models: [] });
      yield* models(codex.url);
      const request = codex.modelRequests.at(-1);
      expect(request?.path).toBe("/codex/models");
      expect(request?.headers).toMatchObject({
        authorization: "Bearer at-1",
        "chatgpt-account-id": "acc-1",
      });
    }),
  );

  it.effect("fails with ModelsUnavailableError when Codex does not answer 200", () =>
    Effect.gen(function* () {
      const codex = yield* startFakeCodex;
      // No Codex route lives under this prefix, so the fake answers 404.
      const error = yield* Effect.flip(models(`${codex.url}/elsewhere`));
      expect(error).toBeInstanceOf(ModelsUnavailableError);
      expect(error).toMatchObject({ status: 404 });
      expect(error.message).toBe("Codex did not list its models (HTTP 404)");
    }),
  );
});
