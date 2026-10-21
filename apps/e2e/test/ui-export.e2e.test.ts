import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { Effect, type Schema } from "effect";
import { chromium, webkit } from "playwright";
import {
  adminKey,
  launchVia,
  openPage,
  signIn,
  startCodex,
  toast,
  type Via,
  withBinary,
} from "./harness.ts";

/** A key the failed turn's prompt holds, fake, which the report must hold only redacted. */
const KEY = "sk-proj-e2eFAKEk3yAbCdEfGhIjKlMnOpQrStUv0123456789";

/** Calls the admin API with the admin key. */
const admin = (via: Via, path: string, method: string, body: Schema.JsonObject) =>
  Effect.promise(() =>
    fetch(`${via.url}/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** A via keeping failed turns' prompts, with one turn of OpenCode's that Codex failed. */
const viaWithFailedTurn = Effect.gen(function* () {
  const codex = yield* startCodex;

  const via = yield* launchVia({
    upstream: codex.url,
    accounts: [{ name: "a" }],
    env: { VIA_ADMIN_KEY: adminKey },
  });

  expect((yield* admin(via, "/history/capture", "PUT", { keepFailedPrompts: true })).status).toBe(
    200,
  );

  codex.script(reply.error(503, { error: { type: "server_error", code: "server_is_overloaded" } }));

  const failed = yield* Effect.promise(() =>
    fetch(`${via.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${via.key}`,
        "user-agent": "opencode/latest/2.0.32/cli",
        "x-opencode-session-id": "ses-export",
      },
      body: JSON.stringify({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: `Why does ${KEY} fail?` }],
      }),
    }),
  );

  expect(failed.status).toBe(503);

  return via;
});

layer(BunFileSystem.layer)("exporting a conversation in a browser", (it) => {
  for (const engine of [chromium, webkit]) {
    it.effect.runIf(withBinary)(
      `copies a conversation with a failed turn as Markdown, in ${engine.name()}`,
      () =>
        Effect.gen(function* () {
          const via = yield* viaWithFailedTurn;

          // Reading the clipboard back takes a permission in both. Writing it takes one in
          // Chromium; WebKit knows no such permission and lets a click write, as Safari does.
          const { page, problems } = yield* openPage(
            `export-markdown-${engine.name()}`,
            {
              permissions:
                engine === chromium ? ["clipboard-read", "clipboard-write"] : ["clipboard-read"],
            },
            engine,
          );

          yield* signIn(page, via.url);

          yield* Effect.promise(() =>
            page.goto(`${via.url}/ui/usage?tab=conversations&conversation=ses-export`),
          );

          // The capture is listed with the conversation, so the export holds it.
          yield* Effect.promise(() =>
            page
              .getByRole("table", { name: "Turns" })
              .getByRole("button", { name: "View request" })
              .waitFor(),
          );
          yield* Effect.promise(() => page.getByRole("button", { name: "Export" }).click());
          yield* Effect.promise(() =>
            page.getByRole("menuitem", { name: "Copy as Markdown" }).click(),
          );
          yield* toast(page, "Markdown copied");

          const copied = yield* Effect.promise(() =>
            page.evaluate<string>("navigator.clipboard.readText()"),
          );

          expect(copied).toMatch(/^# OpenCode 2\.0\.32 · ses-export\n/);
          expect(copied).toContain("redacted:openai-key");
          expect(copied).not.toContain(KEY);
          expect(problems).toEqual([]);
        }),
    );
  }
});
