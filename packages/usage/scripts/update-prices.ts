/**
 * Regenerates `src/price-snapshot.ts` from models.dev's and LiteLLM's price
 * tables; `snapshot.ts` says which prices it takes from each. LiteLLM's is read
 * at the commit its main branch is at, which the header names. When no price
 * changed, the snapshot is left as it is, its header included.
 *
 * Run with `bun run prices:update`, then review the diff.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { priceSnapshot } from "../src/price-snapshot.ts";
import {
  LITELLM_HEAD,
  LiteLlm,
  litellmAt,
  MODELS_DEV,
  ModelsDev,
  pricesChanged,
  pricesOf,
  snapshotSource,
} from "./snapshot.ts";

const TARGET = new URL("../src/price-snapshot.ts", import.meta.url).pathname;

const Commit = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));

const getJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  url: string,
  schema: S,
) => HttpClient.get(url).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)));

/** The commit LiteLLM's main branch is at, which GitHub gives bare for this media type. */
const litellmCommit = HttpClient.execute(
  HttpClientRequest.get(LITELLM_HEAD).pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github.sha"),
  ),
).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap((response) => response.text),
  Effect.flatMap((text) => Schema.decodeUnknownEffect(Commit)(text.trim())),
);

const program = Effect.gen(function* () {
  const commit = yield* litellmCommit;
  const litellm = yield* getJson(litellmAt(commit), LiteLlm);
  const modelsDev = yield* getJson(MODELS_DEV, ModelsDev);
  const prices = pricesOf(litellm, modelsDev);

  if (!pricesChanged(priceSnapshot, prices)) {
    return yield* Effect.log(`No price changed; left ${TARGET} as it was`);
  }

  const date = DateTime.formatIsoDateUtc(yield* DateTime.now);
  const source = snapshotSource(prices, { litellmCommit: commit, date });

  yield* (yield* FileSystem.FileSystem).writeFileString(TARGET, source);
  yield* Effect.log(`Wrote ${prices.length} model prices to ${TARGET}`);
});

BunRuntime.runMain(program.pipe(Effect.provide([FetchHttpClient.layer, BunServices.layer])));
