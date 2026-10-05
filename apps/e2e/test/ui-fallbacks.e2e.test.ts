import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { startFakeProvider } from "@via/providers/testing";
import { Effect, Schema } from "effect";
import type { Locator, Page } from "playwright";
import {
  adminKey,
  json,
  launchVia,
  openPage,
  rowAction,
  signIn,
  startCodex,
  toast,
  type Via,
  visible,
  withBinary,
} from "./harness.ts";

const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** The reasoning efforts a Codex model's id can end in. */
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

/** Codex models via lists, each once: an effort variant goes with its model. */
const codexModels = (via: Via) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${via.url}/v1/models`, { headers: { authorization: `Bearer ${via.key}` } }),
    );

    const { data } = yield* Schema.decodeUnknownEffect(Models)(yield* json(response));
    const ids = data.map(({ id }) => id).filter((id) => !id.includes("/"));

    return ids.filter(
      (id) =>
        !EFFORTS.some(
          (effort) => ids.includes(id.slice(0, -(effort.length + 1))) && id.endsWith(`-${effort}`),
        ),
    );
  });

const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Opens the picker named `picker` in `scope` and clicks the option that reads `name`. */
const pick = (page: Page, scope: Locator, picker: string, name: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => scope.getByRole("combobox", { name: picker, exact: true }).click());
    yield* Effect.promise(() =>
      page.getByRole("option", { name: new RegExp(`^${escaped(name)}`) }).click(),
    );
    yield* Effect.promise(() => page.getByRole("listbox").waitFor({ state: "detached" }));
  });

/** The models the dialog's list holds, in order. */
const editorChain = (dialog: Locator) =>
  Effect.promise(() =>
    dialog
      .getByRole("list", { name: "Fall back to, in order" })
      .getByRole("listitem")
      .locator("[title]")
      .allTextContents(),
  );

/** The models a rule's row falls back to, in order. */
const rowChain = (page: Page, source: string) =>
  Effect.promise(() =>
    page
      .getByRole("article", { name: source })
      .getByRole("list", { name: "Falls back to" })
      .getByRole("listitem")
      .allTextContents(),
  );

layer(BunFileSystem.layer)("managing fallbacks in the admin UI", (it) => {
  it.effect.runIf(withBinary)("adds a rule in the dialog, reorders it, edits and removes it", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;
      codex.respond(() => reply.text("hi"));

      // A model server of one's own, with three models to fall back to.
      const acme = yield* startFakeProvider;
      const [first, second, third] = ["alpha", "bravo", "charlie"] as const;
      acme.models([first, second, third]);

      const via = yield* launchVia({
        upstream: codex.url,
        accounts: [{ name: "a" }],
        env: { VIA_ADMIN_KEY: adminKey },
        config: `providers:\n  acme:\n    baseUrl: ${acme.url}\n`,
      });

      const [source] = yield* codexModels(via);

      if (source === undefined) return yield* Effect.die("The fake Codex lists no model");

      const { page, problems } = yield* openPage("fallbacks");

      yield* signIn(page, via.url);
      yield* Effect.promise(() => page.getByRole("link", { name: "Fallbacks" }).click());
      yield* visible(page, "No fallbacks yet");

      yield* Effect.promise(() => page.getByRole("button", { name: "Add fallback" }).click());
      const dialog = page.getByRole("dialog", { name: "Add a fallback" });
      yield* Effect.promise(() => dialog.waitFor());

      // The picker opens over the modal and takes the keyboard: type, then Enter picks the first match.
      yield* Effect.promise(() =>
        dialog.getByRole("combobox", { name: "Fall back from", exact: true }).click(),
      );
      yield* Effect.promise(() => page.keyboard.type(source));
      yield* Effect.promise(() => page.keyboard.press("Enter"));
      yield* Effect.promise(() =>
        dialog.getByRole("combobox", { name: `Fall back from: ${source}` }).waitFor(),
      );

      yield* pick(page, dialog, "Add model", first);
      yield* pick(page, dialog, "Add model", second);
      yield* pick(page, dialog, "Add model", third);
      expect(yield* editorChain(dialog)).toEqual([first, second, third]);
      // Add model went with the third, and focus stays in the list, on the model just added.
      yield* Effect.promise(() =>
        dialog
          .getByRole("button", { name: `Remove ${third}` })
          .and(page.locator(":focus"))
          .waitFor({ timeout: 5_000 }),
      );

      yield* Effect.promise(() => dialog.getByRole("button", { name: `Move ${third} up` }).click());
      expect(yield* editorChain(dialog)).toEqual([first, third, second]);

      yield* Effect.promise(() => dialog.getByRole("button", { name: `Remove ${first}` }).click());
      expect(yield* editorChain(dialog)).toEqual([third, second]);

      yield* Effect.promise(() => dialog.getByRole("button", { name: "Add fallback" }).click());
      yield* toast(page, "Fallback added");
      yield* Effect.promise(() => dialog.waitFor({ state: "detached" }));
      expect(yield* rowChain(page, source)).toEqual([third, second]);

      // Kept by via: a reload shows it again.
      yield* Effect.promise(() => page.reload());
      yield* visible(page, "Fallbacks");
      expect(yield* rowChain(page, source)).toEqual([third, second]);

      yield* rowAction(page, source, "Edit…");
      const edit = page.getByRole("dialog", { name: `Edit the fallback for ${source}` });
      yield* Effect.promise(() => edit.waitFor());
      expect(yield* editorChain(edit)).toEqual([third, second]);
      yield* Effect.promise(() => edit.getByRole("button", { name: `Move ${second} up` }).click());
      yield* Effect.promise(() => edit.getByRole("button", { name: "Save fallback" }).click());
      yield* toast(page, "Fallback saved");
      yield* Effect.promise(() => edit.waitFor({ state: "detached" }));
      expect(yield* rowChain(page, source)).toEqual([second, third]);

      yield* rowAction(page, source, "Remove…");
      yield* visible(page, `Remove the fallback for ${source}?`);
      yield* Effect.promise(() => page.getByRole("button", { name: "Remove fallback" }).click());
      yield* toast(page, "Fallback removed");
      yield* visible(page, "No fallbacks yet");

      expect(problems).toEqual([]);
    }),
  );
});
