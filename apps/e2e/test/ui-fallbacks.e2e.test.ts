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

/**
 * Expects `items` to read `expected`, in order. It waits for them first: a list may still
 * be rendering, or still show what it held before a change.
 */
const expectInOrder = (items: Locator, expected: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      Promise.allSettled([
        ...expected.map((text, index) =>
          items
            .nth(index)
            .filter({ hasText: new RegExp(`^${escaped(text)}$`) })
            .waitFor(),
        ),
        items.nth(expected.length).waitFor({ state: "detached" }),
      ]),
    );
    expect(yield* Effect.promise(() => items.allTextContents())).toEqual(expected);
  });

/** Expects the dialog's list to hold `expected`, in order. */
const expectEditorChain = (dialog: Locator, expected: ReadonlyArray<string>) =>
  expectInOrder(
    dialog
      .getByRole("list", { name: "Fall back to, in order" })
      .getByRole("listitem")
      .locator("[title]"),
    expected,
  );

/** Expects the rule for `source` to fall back to `expected`, in order. */
const expectRowChain = (page: Page, source: string, expected: ReadonlyArray<string>) =>
  expectInOrder(
    page
      .getByRole("article", { name: source })
      .getByRole("list", { name: "Falls back to" })
      .getByRole("listitem"),
    expected,
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
      yield* visible(page, "Fallbacks");
      yield* visible(page, "No fallbacks yet");

      yield* Effect.promise(() => page.getByRole("button", { name: "Add fallback" }).click());
      const dialog = page.getByRole("dialog", { name: "Add a fallback" });
      yield* Effect.promise(() => dialog.waitFor());

      // The picker opens over the modal and takes the keyboard: type, then Enter picks the first match.
      // Typed only once its search has focus: until then, the keys go to the trigger and are lost.
      yield* Effect.promise(() =>
        dialog.getByRole("combobox", { name: "Fall back from", exact: true }).click(),
      );
      yield* Effect.promise(() =>
        page
          .getByRole("combobox", { name: "Fall back from", exact: true })
          .and(page.locator("input:focus"))
          .waitFor(),
      );
      yield* Effect.promise(() => page.keyboard.type(source));
      // Enter picks the highlighted option, so only once the search has highlighted the match.
      yield* Effect.promise(() =>
        page
          .getByRole("option", { name: new RegExp(`^${escaped(source)}`) })
          .and(page.locator("[data-highlighted]"))
          .waitFor(),
      );
      yield* Effect.promise(() => page.keyboard.press("Enter"));
      yield* Effect.promise(() =>
        dialog.getByRole("combobox", { name: `Fall back from: ${source}` }).waitFor(),
      );
      yield* Effect.promise(() => page.getByRole("listbox").waitFor({ state: "detached" }));

      yield* pick(page, dialog, "Add model", first);
      yield* pick(page, dialog, "Add model", second);
      yield* pick(page, dialog, "Add model", third);
      yield* expectEditorChain(dialog, [first, second, third]);
      // Add model went with the third, and focus stays in the list, on the model just added.
      yield* Effect.promise(() =>
        dialog
          .getByRole("button", { name: `Remove ${third}` })
          .and(page.locator(":focus"))
          .waitFor({ timeout: 5_000 }),
      );

      yield* Effect.promise(() => dialog.getByRole("button", { name: `Move ${third} up` }).click());
      yield* expectEditorChain(dialog, [first, third, second]);

      yield* Effect.promise(() => dialog.getByRole("button", { name: `Remove ${first}` }).click());
      yield* expectEditorChain(dialog, [third, second]);

      yield* Effect.promise(() => dialog.getByRole("button", { name: "Add fallback" }).click());
      yield* toast(page, "Fallback added");
      yield* Effect.promise(() => dialog.waitFor({ state: "detached" }));
      yield* expectRowChain(page, source, [third, second]);

      // Kept by via: a reload shows it again.
      yield* Effect.promise(() => page.reload());
      yield* visible(page, "Fallbacks");
      yield* expectRowChain(page, source, [third, second]);

      yield* rowAction(page, source, "Edit…");
      const edit = page.getByRole("dialog", { name: `Edit the fallback for ${source}` });
      yield* Effect.promise(() => edit.waitFor());
      yield* expectEditorChain(edit, [third, second]);
      yield* Effect.promise(() => edit.getByRole("button", { name: `Move ${second} up` }).click());
      yield* Effect.promise(() => edit.getByRole("button", { name: "Save fallback" }).click());
      yield* toast(page, "Fallback saved");
      yield* Effect.promise(() => edit.waitFor({ state: "detached" }));
      yield* expectRowChain(page, source, [second, third]);

      yield* rowAction(page, source, "Remove…");
      yield* visible(page, `Remove the fallback for ${source}?`);
      yield* Effect.promise(() => page.getByRole("button", { name: "Remove fallback" }).click());
      yield* toast(page, "Fallback removed");
      yield* visible(page, "No fallbacks yet");

      expect(problems).toEqual([]);
    }),
  );
});
