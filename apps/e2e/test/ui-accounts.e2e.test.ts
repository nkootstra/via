import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import type { Page } from "playwright";
import {
  adminKey,
  errorFixture,
  type Codex,
  launchVia,
  openPage,
  post,
  rowAction,
  responsesOf,
  signIn,
  startCodex,
  toast,
  visible,
  type Via,
  withBinary,
} from "./harness.ts";

/**
 * A Responses request through via opening with `input`, and the ChatGPT account
 * Codex got it for. Each needs its own `input`: via keeps a conversation, known
 * by its opening, on the account that answered it.
 */
const servedBy = (via: Via, codex: Codex, input: string) =>
  Effect.gen(function* () {
    const served = yield* post(via, "/v1/responses", { model: "gpt-5.1-codex", input });
    expect(served.status).toBe(200);

    return responsesOf(codex).at(-1)?.headers["chatgpt-account-id"];
  });

/** Flips the enabled switch of the account labelled `label`, once via has saved it. */
const toggleEnabled = (page: Page, label: string) =>
  Effect.promise(() =>
    Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" && response.url().includes("/admin/accounts/"),
      ),
      page.getByRole("switch", { name: `${label} enabled` }).click(),
    ]),
  );

layer(BunFileSystem.layer)("managing accounts in the admin UI", (it) => {
  it.effect.runIf(withBinary)(
    "adds a ChatGPT account with a device login, and serves with it",
    () =>
      Effect.gen(function* () {
        const codex = yield* startCodex;
        codex.respond(() => reply.text("hi"));

        // An empty pool: the account comes from the UI alone.
        const via = yield* launchVia({
          upstream: codex.url,
          accounts: [],
          env: { VIA_ADMIN_KEY: adminKey },
        });

        const { page, problems } = yield* openPage("add-account");
        yield* signIn(page, via.url);
        yield* Effect.promise(() => page.getByRole("link", { name: "Accounts" }).click());
        // The page's own heading first: the overview, which is going, says "No accounts yet"
        // and has an Add account button too.
        yield* visible(page, "Accounts");
        yield* visible(page, "No accounts yet");

        yield* Effect.promise(() => page.getByRole("button", { name: "Add account" }).click());
        yield* Effect.promise(() =>
          page.getByRole("button", { name: /ChatGPT \(Codex\)/ }).click(),
        );
        // The fake issuer approves at once, so the dialog with the code may be gone before a
        // check for it runs: the toast and the new row say the login went through.
        yield* toast(page, "Account added");

        const accounts = page.getByRole("table", { name: "ChatGPT accounts" });
        yield* Effect.promise(() => accounts.getByText("dev@example.com").first().waitFor());

        expect(yield* servedBy(via, codex, "first")).toBe("acc-123");
        expect(problems).toEqual([]);
      }),
  );

  it.effect.runIf(withBinary)(
    "signs a locked-out account in again from the overview, back in rotation at once",
    () =>
      Effect.gen(function* () {
        const codex = yield* startCodex;

        const via = yield* launchVia({
          upstream: codex.url,
          issuer: {
            refreshResponse: {
              status: 400,
              body: { error: "invalid_grant", error_description: "refresh token expired" },
            },
          },
          env: { VIA_ADMIN_KEY: adminKey },
        });

        // Codex refuses the token and the issuer refuses its refresh: via locks the account out.
        codex.script(yield* errorFixture("unauthorized_401"));
        const refused = yield* post(via, "/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
        expect(refused.status).not.toBe(200);

        const { page, problems } = yield* openPage("sign-in-again");
        yield* signIn(page, via.url);
        const signInAgain = page.getByRole("button", { name: "Sign in again" });
        yield* Effect.promise(() => signInAgain.click());
        // As when adding one, the issuer approves at once: the toast says the login went through.
        yield* toast(page, "Signed in again");
        yield* Effect.promise(() => signInAgain.waitFor({ state: "detached" }));

        codex.respond(() => reply.text("hi"));
        expect(yield* servedBy(via, codex, "after")).toBe("acc-123");
        expect(problems).toEqual([]);
      }),
  );

  it.effect.runIf(withBinary)(
    "disables, renames and removes an account, and via's routing follows each change",
    () =>
      Effect.gen(function* () {
        const codex = yield* startCodex;
        codex.respond(() => reply.text("hi"));

        const via = yield* launchVia({
          upstream: codex.url,
          accounts: [{ name: "a" }, { name: "b" }],
          env: { VIA_ADMIN_KEY: adminKey },
        });

        const { page, problems } = yield* openPage("manage-accounts");
        yield* signIn(page, via.url);
        yield* Effect.promise(() => page.getByRole("link", { name: "Accounts" }).click());
        yield* visible(page, "Accounts");

        // Fill-first hands out the oldest account, until it is disabled.
        expect(yield* servedBy(via, codex, "before")).toBe("acc-a");
        yield* toggleEnabled(page, "a");
        expect(yield* servedBy(via, codex, "while disabled")).toBe("acc-b");
        yield* toggleEnabled(page, "a");
        expect(yield* servedBy(via, codex, "enabled again")).toBe("acc-a");

        yield* rowAction(page, "a", "Rename…");
        yield* visible(page, "Rename a");
        yield* Effect.promise(() => page.getByRole("textbox", { name: "Label" }).fill("work"));
        yield* Effect.promise(() => page.getByRole("button", { name: "Rename" }).click());
        yield* toast(page, "Account renamed");
        const accounts = page.getByRole("table", { name: "ChatGPT accounts" });
        yield* Effect.promise(() => accounts.getByText("work", { exact: true }).waitFor());

        yield* rowAction(page, "work", "Remove…");
        yield* visible(page, "Remove work?");
        yield* Effect.promise(() => page.getByRole("button", { name: "Remove account" }).click());
        yield* toast(page, "Account removed");
        yield* Effect.promise(() =>
          accounts.getByText("a@example.com").waitFor({ state: "detached" }),
        );

        expect(yield* servedBy(via, codex, "after removal")).toBe("acc-b");
        expect(problems).toEqual([]);
      }),
  );
});
