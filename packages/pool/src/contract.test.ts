import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { codexFixture } from "@via/codex-upstream/testing";
import { Effect, Schema } from "effect";
import { classify, Verdict } from "./index.ts";

// Contract tests: the HTTP errors codex's own tests expect from the backend.
const ErrorFixtures = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      status: Schema.Int,
      headers: Schema.Record(Schema.String, Schema.String),
      body: Schema.Unknown,
    }),
  ),
);

const NOW = 1_704_067_000_000;
const MINUTE = 60_000;

const classifyFixture = (name: string) =>
  Effect.gen(function* () {
    const fixtures = yield* codexFixture("errors.json").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ErrorFixtures)),
    );
    const fixture = fixtures[name];
    expect(fixture).toBeDefined();
    const { status, headers, body } = fixture!;
    const lowered = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    return classify(status, lowered, JSON.stringify(body), NOW);
  });

layer(BunFileSystem.layer)("classify against codex's error fixtures", (it) => {
  it.effect("cools a usage-limited account down until resets_at", () =>
    Effect.gen(function* () {
      expect(yield* classifyFixture("usage_limit_reached")).toEqual(
        Verdict.Cooldown({
          until: 1_704_067_242_000,
          reason: "usage_limit_reached",
        }),
      );
    }),
  );

  it.effect("refreshes on a 401", () =>
    Effect.gen(function* () {
      expect(yield* classifyFixture("unauthorized_401")).toEqual(Verdict.Unauthorized());
    }),
  );

  it.effect("cools an overloaded server down briefly", () =>
    Effect.gen(function* () {
      expect(yield* classifyFixture("server_overloaded_503")).toEqual(
        Verdict.Cooldown({
          until: NOW + MINUTE,
          reason: "server_is_overloaded",
        }),
      );
    }),
  );

  it.effect("names a server error by its type even when its code is null", () =>
    Effect.gen(function* () {
      expect(yield* classifyFixture("internal_server_error_500")).toEqual(
        Verdict.Cooldown({ until: NOW + MINUTE, reason: "server_error" }),
      );
    }),
  );
});
