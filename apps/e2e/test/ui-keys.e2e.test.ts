import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import {
  adminKey,
  launchVia,
  openPage,
  post,
  rowAction,
  signIn,
  startCodex,
  toast,
  visible,
  withBinary,
} from "./harness.ts";

layer(BunFileSystem.layer)("managing API keys in the admin UI", (it) => {
  it.effect.runIf(withBinary)(
    "creates a key, copies it once, renames it and revokes it, and /v1 follows each step",
    () =>
      Effect.gen(function* () {
        const codex = yield* startCodex;
        codex.respond(() => reply.text("hi"));

        const via = yield* launchVia({
          upstream: codex.url,
          accounts: [{ name: "a" }],
          env: { VIA_ADMIN_KEY: adminKey },
        });

        const statusWith = (key: string) =>
          Effect.map(
            post({ ...via, key }, "/v1/responses", { model: "gpt-5.1-codex", input: "hi" }),
            (response) => response.status,
          );

        const { page, problems } = yield* openPage("keys", {
          permissions: ["clipboard-read", "clipboard-write"],
        });

        yield* signIn(page, via.url);
        yield* Effect.promise(() => page.getByRole("link", { name: "Keys" }).click());
        yield* visible(page, "Keys");

        yield* Effect.promise(() => page.getByRole("button", { name: "Create key" }).click());
        const dialog = page.getByRole("dialog");
        yield* Effect.promise(() => dialog.getByRole("textbox", { name: "Name" }).fill("laptop"));
        yield* Effect.promise(() => dialog.getByRole("button", { name: "Create key" }).click());
        yield* visible(page, "Your new key: laptop");

        // The key is shown this once; copying it is how it reaches a client.
        yield* Effect.promise(() => dialog.getByRole("button", { name: "Copy API key" }).click());

        const key = yield* Effect.promise(() =>
          page.evaluate<string>("navigator.clipboard.readText()"),
        );

        expect(key).toMatch(/^via_/);
        yield* Effect.promise(() => dialog.getByRole("button", { name: "Done" }).click());

        const keys = page.getByRole("table", { name: "Keys" });
        yield* Effect.promise(() => keys.getByText("laptop", { exact: true }).waitFor());
        expect(yield* statusWith(key)).toBe(200);

        yield* rowAction(page, "laptop", "Rename…");
        yield* visible(page, "Rename laptop");
        yield* Effect.promise(() => page.getByRole("textbox", { name: "Name" }).fill("desk"));
        yield* Effect.promise(() => page.getByRole("button", { name: "Rename" }).click());
        yield* toast(page, "Key renamed");
        yield* Effect.promise(() => keys.getByText("desk", { exact: true }).waitFor());
        // A rename keeps the key itself.
        expect(yield* statusWith(key)).toBe(200);

        yield* rowAction(page, "desk", "Revoke…");
        yield* visible(page, "Revoke desk?");
        yield* Effect.promise(() => page.getByRole("button", { name: "Revoke key" }).click());
        yield* toast(page, "Key revoked");
        yield* Effect.promise(() =>
          keys.getByText("desk", { exact: true }).waitFor({ state: "detached" }),
        );

        expect(yield* statusWith(key)).toBe(401);
        // The other key is untouched.
        expect(yield* statusWith(via.key)).toBe(200);
        expect(problems).toEqual([]);
      }),
  );
});
