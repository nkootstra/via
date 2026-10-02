/**
 * Regenerates `src/price-snapshot.ts` from models.dev's and LiteLLM's price
 * tables; `snapshot.ts` says which prices it takes from each.
 *
 * Run with `bun run prices:update`, then review the diff.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { LITELLM, LiteLlm, MODELS_DEV, ModelsDev, pricesOf, snapshotSource } from "./snapshot.ts";

const TARGET = new URL("../src/price-snapshot.ts", import.meta.url).pathname;

const getJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  url: string,
  schema: S,
) => HttpClient.get(url).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)));

const program = Effect.gen(function* () {
  const litellm = yield* getJson(LITELLM, LiteLlm);
  const modelsDev = yield* getJson(MODELS_DEV, ModelsDev);
  const prices = pricesOf(litellm, modelsDev);

  yield* (yield* FileSystem.FileSystem).writeFileString(TARGET, snapshotSource(prices));
  yield* Effect.log(`Wrote ${prices.length} model prices to ${TARGET}`);
});

BunRuntime.runMain(program.pipe(Effect.provide([FetchHttpClient.layer, BunServices.layer])));
