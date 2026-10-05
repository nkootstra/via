import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { providerReply, startFakeProvider } from "@via/providers/testing";
import { Effect } from "effect";
import { launchVia, post, runVia, startCodex } from "./harness.ts";

// A real `via serve` whose only Codex account has used up its limit, and a rule set
// with `via fallbacks set` while it runs.

layer(BunFileSystem.layer)("fallback models", (it) => {
  it.effect("answers with the fallback a running via serve was given, without a restart", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.respond(() =>
        reply.error(429, { error: { code: "usage_limit_reached" } }, { "retry-after": "3600" }),
      );

      const provider = yield* startFakeProvider;
      provider.respond(providerReply.json({ id: "chatcmpl-fallback", choices: [] }));

      const via = yield* launchVia({
        upstream: codex.url,
        accounts: [{ name: "a" }],
        env: { VIA_E2E_OPENROUTER_KEY: "sk-or-e2e" },
        config: `providers:\n  openrouter:\n    baseUrl: ${provider.url}\n    apiKeyEnv: VIA_E2E_OPENROUTER_KEY\n`,
      });

      const ask = post(via, "/v1/chat/completions", { model: "gpt-x", messages: [] });

      expect((yield* ask).status).toBe(429);

      const set = yield* runVia(via.home, ["fallbacks", "set", "gpt-x", "openrouter/y"], via.env);
      expect(set.exitCode).toBe(0);

      const listed = yield* runVia(via.home, ["fallbacks", "list"], via.env);
      expect(listed.stdout).toContain("gpt-x  -> openrouter/y");

      const answered = yield* ask;
      expect(answered.status).toBe(200);
      expect(answered.headers.get("x-via-fallback")).toBe("gpt-x -> openrouter/y");
      expect(provider.requests.map((request) => request.body["model"])).toEqual(["y"]);
    }),
  );
});
