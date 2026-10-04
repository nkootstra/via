import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { providerReply } from "@via/providers/testing";
import { Effect } from "effect";
import { ok, withVia } from "./testing/harness.ts";

/** Every Codex account answers that its usage limit is reached. */
const exhausted = () => reply.error(429, "", { "retry-after": "120" });

const answer = { id: "chatcmpl-1", object: "chat.completion", choices: [] };

layer(BunFileSystem.layer)("fallback models", (it) => {
  it.effect("answers with the fallback when every account for the model is cooling down", () =>
    withVia(
      exhausted,
      (via) =>
        Effect.gen(function* () {
          via.provider.respond(providerReply.json(answer));

          const response = yield* via.post("/v1/responses", { model: "gpt-x", input: "hi" });

          expect(response.status).toBe(200);
          expect(response.headers["x-via-fallback"]).toBe("gpt-x -> openrouter/y");
          expect(yield* response.json).toEqual(answer);
          expect(via.provider.requests.map((request) => request.body["model"])).toEqual(["y"]);
        }),
      { fallbacks: [{ model: "gpt-x", fallbacks: ["openrouter/y"] }] },
    ),
  );
});
