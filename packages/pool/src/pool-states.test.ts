import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PoolStates } from "./pool-states.ts";

it.effect("remembers what serve learned about each account", () =>
  Effect.gen(function* () {
    const states = yield* PoolStates;
    expect(yield* states.get).toEqual({});
    yield* states.mark("acc-a", {
      status: "cooling",
      until: 5,
      reason: "usage_limit_reached",
    });
    yield* states.lockOut("acc-b", "refresh_token_expired");
    expect(yield* states.get).toEqual({
      "acc-a": { status: "cooling", until: 5, reason: "usage_limit_reached" },
      "acc-b": { status: "auth_error", reason: "refresh_token_expired" },
    });
  }).pipe(Effect.provide(PoolStates.layer)),
);
