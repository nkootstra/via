import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream, reply } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { withVia } from "./harness.ts";

const ok = () => reply.sse(completedStream("hello"));

layer(BunFileSystem.layer)("choosing an account", (it) => {
  it.effect(
    "moves on to the next account when a request finds the first one's refresh rejected",
    () =>
      withVia(
        ok,
        (via) =>
          Effect.gen(function* () {
            // Only now is "a" close enough to expiring to be refreshed: as via started, it
            // still had seven minutes, so asking Codex for the models needed no refresh.
            yield* TestClock.adjust("3 minutes");

            // No model, so via doesn't ask the model catalog which accounts may serve it:
            // asking Codex for the catalog again would refresh "a" before the request did.
            const response = yield* via.post("/v1/responses", { input: "hi" });

            expect(response.status).toBe(200);
            expect(yield* via.logged("a@example.com is locked out")).toMatchObject({
              level: "Warn",
            });
            expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
              served_by: "b@example.com",
            });
          }),
        {
          refreshResponse: { status: 400, body: { error: "invalid_grant" } },
          aExpiresAt: 7 * 60 * 1000,
        },
      ),
  );
});
