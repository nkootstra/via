import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { createKey, serveVia, viaHome, writeConfig } from "@via/cli/testing";
import { providerReply, startFakeProvider } from "@via/providers/testing";
import { Effect } from "effect";
import { runVia, startCodex } from "./harness.ts";

// Two OpenCode Go keys added through the CLI, behind a real `via serve`, with a
// fake OpenCode Go that scripts each key's answers.

layer(BunFileSystem.layer)("OpenCode Go accounts", (it) => {
  it.effect("fails over from a used-up key to the next, and stays there", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      const provider = yield* startFakeProvider;
      const { home, env } = yield* viaHome({ upstream: codex.url });

      yield* writeConfig(
        home,
        `providers:\n  opencode-go:\n    baseUrl: ${provider.url}\n    apiKeyEnv: VIA_E2E_UNSET\n`,
      );

      for (const key of ["sk-go-first", "sk-go-second"]) {
        const added = yield* runVia(
          home,
          ["accounts", "add", "--provider", "opencode-go"],
          env,
          key,
        );

        expect(added.exitCode).toBe(0);
      }

      const reset = new Date(Date.now() + 3_600_000).toISOString();
      provider.usageFor("sk-go-first", {
        usage: { weekly: { status: "rate-limited", percent: 100, resetsAt: reset } },
      });
      provider.respond(
        providerReply.byKey({
          "sk-go-first": providerReply.rateLimited(),
          "sk-go-second": providerReply.json({ id: "chatcmpl-second", choices: [] }),
        }),
      );

      const key = yield* createKey(home, "e2e");
      const url = yield* serveVia(home, ["--port", "0"], env);

      const ask = Effect.promise(() =>
        fetch(`${url}/v1/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "opencode-go/kimi-k3", messages: [] }),
        }).then((response) => response.json()),
      );

      expect(yield* ask).toEqual({ id: "chatcmpl-second", choices: [] });
      expect(yield* ask).toEqual({ id: "chatcmpl-second", choices: [] });
      // The usage poll's first pass, at startup, may already have seen the first key used
      // up and rested it; if not, its 429 does. Either way it is tried at most once, first.
      const used = provider.requests.map(({ headers }) => headers["authorization"]);
      const tried = used[0] === "Bearer sk-go-first" ? used.slice(1) : used;
      expect(tried).toEqual(["Bearer sk-go-second", "Bearer sk-go-second"]);

      const status = yield* runVia(home, ["accounts", "status"], { ...env, TZ: "UTC" });
      expect(status.stdout).toMatch(/…irst {2}enabled {2}exhausted until .* \(weekly\)/);
      expect(status.stdout).toMatch(/…cond {2}enabled {2}unavailable/);
    }),
  );
});
