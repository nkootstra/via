import { screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { account, opencodeGoAccount } from "../src/testing/admin-handlers.ts";
import { renderApp } from "./app.tsx";

/**
 * The last audit started. axe runs one audit at a time and refuses a second
 * while one is going, and a test that times out leaves its audit running, so
 * each audit waits for the one before it rather than failing the next test.
 */
let lastAudit: Promise<unknown> = Promise.resolve();

/**
 * What axe finds in `scope`, the whole document by default. happy-dom
 * computes no colours behind text, so contrast is left to a real browser.
 * Base UI's focus guards are aria-hidden yet tabbable by design: each hands
 * focus straight on to the popup or its trigger, and never keeps it. Only
 * violations are read, so axe keeps no detail on what passed.
 */
async function violations(scope: Element | Document = document) {
  const audit = lastAudit
    .catch(() => undefined)
    .then(() =>
      axe.run(
        { include: [scope], exclude: [["[data-base-ui-focus-guard]"]] },
        { resultTypes: ["violations"], rules: { "color-contrast": { enabled: false } } },
      ),
    );

  lastAudit = audit;
  const found = await audit;

  return found.violations.map(
    ({ id, help, nodes }) =>
      `${id}: ${help}\n  ${nodes.map((n) => n.target.join(" ")).join("\n  ")}`,
  );
}

const fetchedAt = "2026-09-27T11:59:30.000Z";

const populated = {
  accounts: [account({ id: "acc-1", label: "work" }), account({ id: "acc-2", label: "home" })],
  opencodeGo: [opencodeGoAccount({ id: "go-1", label: "go main" })],
  keys: [
    { id: "key-1", name: "laptop", createdAt: "2026-09-01T10:00:00.000Z", lastUsedAt: null },
    {
      id: "key-2",
      name: "ci",
      createdAt: "2026-09-02T10:00:00.000Z",
      lastUsedAt: "2026-09-27T11:00:00.000Z",
    },
  ],
  pool: {
    accounts: [
      { id: "acc-1", label: "work", enabled: true, state: { status: "available" as const } },
      {
        id: "acc-2",
        label: "home",
        enabled: true,
        state: { status: "auth_error" as const, reason: "Refresh token revoked" },
      },
    ],
    opencodeGo: [
      { id: "go-1", label: "go main", enabled: true, state: { status: "available" as const } },
    ],
    providers: [{ name: "openrouter", state: { status: "available" as const } }],
  },
  usage: {
    accounts: [
      {
        id: "acc-1",
        label: "work",
        fetchedAt,
        windows: [
          { windowMinutes: 300, usedPercent: 42, resetsAt: "2026-09-27T14:00:00.000Z" },
          { windowMinutes: 10_080, usedPercent: 81, resetsAt: "2026-10-01T09:00:00.000Z" },
        ],
      },
      { id: "acc-2", label: "home", fetchedAt, error: "ChatGPT didn't answer" },
    ],
    opencodeGo: [
      {
        id: "go-1",
        label: "go main",
        fetchedAt,
        windows: [
          {
            window: "rolling" as const,
            status: "ok" as const,
            usedPercent: 40,
            resetsAt: "2026-09-27T16:00:00.000Z",
          },
        ],
      },
    ],
    openrouter: null,
    refreshing: false,
  },
  models: [
    { id: "gpt-5.5", object: "model" as const, created: 0, owned_by: "openai" },
    {
      id: "opencode-go/kimi-k2",
      object: "model" as const,
      created: 0,
      owned_by: "opencode",
      context_length: 262_144,
    },
  ],
};

/** A rule falling back, one model it can't use, as the Fallbacks page shows them. */
const fallbacks = [
  {
    model: "gpt-5.5",
    fallbacks: ["opencode-go/kimi-k2", "openrouter/minimax-m3"],
    status: {
      source: {
        status: "cooling" as const,
        until: "2026-09-27T12:30:00.000Z",
        reason: "usage_limit_reached",
      },
      fallbacks: [
        { status: "available" as const },
        { status: "unavailable" as const, reason: "not_enabled" as const },
      ],
      serving: "opencode-go/kimi-k2",
    },
  },
];

const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

// An open popup is checked on its own: behind it, the page is hidden from
// assistive tech, and its own test checks it.
// Each test may wait up to five seconds for its screen (the setup's
// `asyncUtilTimeout`) and then audits it, which alone takes over a second on a
// busy machine, so it needs more than vitest's default five-second budget.
describe("accessibility", { timeout: 15_000 }, () => {
  it("the sign-in screen", async () => {
    renderApp("/sign-in", { signedIn: false });
    await heading("Sign in");

    expect(await violations()).toEqual([]);
  });

  it("the overview", async () => {
    renderApp("/", { ...populated, fallbacks });
    await screen.findByRole("article", { name: "work" });
    await screen.findByRole("link", { name: "See fallbacks" });

    expect(await violations()).toEqual([]);
  });

  it("the empty overview", async () => {
    renderApp("/");
    await screen.findByRole("region", { name: "No accounts yet" });

    expect(await violations()).toEqual([]);
  });

  it("the accounts page", async () => {
    renderApp("/accounts", populated);
    await screen.findByRole("row", { name: /^work/ });

    expect(await violations()).toEqual([]);
  });

  it("the empty accounts page", async () => {
    renderApp("/accounts");
    await screen.findByRole("region", { name: "No accounts yet" });

    expect(await violations()).toEqual([]);
  });

  it("the keys page", async () => {
    renderApp("/keys", populated);
    await screen.findByRole("row", { name: /^laptop/ });

    expect(await violations()).toEqual([]);
  });

  it("the empty keys page", async () => {
    renderApp("/keys");
    await screen.findByRole("region", { name: "No keys yet" });

    expect(await violations()).toEqual([]);
  });

  it("the models page", async () => {
    renderApp("/models", populated);
    await screen.findByRole("region", { name: "Codex" });

    expect(await violations()).toEqual([]);
  });

  it("the fallbacks page", async () => {
    renderApp("/fallbacks", { ...populated, fallbacks });
    await screen.findByRole("article", { name: "gpt-5.5" });

    expect(await violations()).toEqual([]);
  });

  it("the empty fallbacks page", async () => {
    renderApp("/fallbacks", populated);
    await screen.findByRole("region", { name: "No fallbacks yet" });

    expect(await violations()).toEqual([]);
  });

  it("the add-fallback dialog, with a list and an error", async () => {
    const { user } = renderApp("/fallbacks", populated);

    await user.click(await screen.findByRole("button", { name: "Add fallback" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a fallback" });
    await user.click(within(dialog).getByRole("combobox", { name: "Fall back from" }));
    await user.click(await screen.findByRole("option", { name: /^gpt-5\.5/ }));
    await user.click(within(dialog).getByRole("combobox", { name: "Add model" }));
    await user.click(await screen.findByRole("option", { name: /^kimi-k2/ }));
    await user.click(within(dialog).getByRole("button", { name: "Remove kimi-k2" }));
    await user.click(within(dialog).getByRole("button", { name: "Add fallback" }));
    await within(dialog).findByText("Add at least one model to fall back to.");
    await user.click(within(dialog).getByRole("combobox", { name: "Add model" }));
    await user.click(await screen.findByRole("option", { name: /^kimi-k2/ }));

    expect(await violations(dialog)).toEqual([]);
  });

  it("the add-fallback dialog's open model picker", async () => {
    const { user } = renderApp("/fallbacks", populated);

    await user.click(await screen.findByRole("button", { name: "Add fallback" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a fallback" });
    await user.click(within(dialog).getByRole("combobox", { name: "Fall back from" }));
    const options = await screen.findByRole("listbox");
    // The popup: the search field and the grouped options under it.
    const popup = options.parentElement ?? options;

    expect(await violations(popup)).toEqual([]);
  });

  it("the remove-fallback confirmation", async () => {
    const { user } = renderApp("/fallbacks", { ...populated, fallbacks });

    await user.click(
      within(await screen.findByRole("article", { name: "gpt-5.5" })).getByRole("button", {
        name: "Actions for gpt-5.5",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));

    const confirm = await screen.findByRole("alertdialog", {
      name: "Remove the fallback for gpt-5.5?",
    });

    expect(await violations(confirm)).toEqual([]);
  });

  it("the add-account dialog", async () => {
    const { user } = renderApp("/accounts", populated);
    await screen.findByRole("row", { name: /^work/ });

    await user.click(screen.getAllByRole("button", { name: "Add account" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Add an account" });

    expect(await violations(dialog)).toEqual([]);
  });

  it("an open row actions menu", async () => {
    const { user } = renderApp("/accounts", populated);

    await user.click(
      within(await screen.findByRole("row", { name: /^work/ })).getByRole("button", {
        name: "Actions for work",
      }),
    );
    const menu = await screen.findByRole("menu");

    expect(await violations(menu)).toEqual([]);
  });

  it("the remove-account confirmation", async () => {
    const { user } = renderApp("/accounts", populated);

    await user.click(
      within(await screen.findByRole("row", { name: /^home/ })).getByRole("button", {
        name: "Actions for home",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: /^Remove/ }));
    const confirm = await screen.findByRole("alertdialog", { name: "Remove home?" });

    expect(await violations(confirm)).toEqual([]);
  });

  it("the revoke-key confirmation", async () => {
    const { user } = renderApp("/keys", populated);
    const row = within(await screen.findByRole("row", { name: /^laptop/ }));

    // The keys page may put revoking in a row menu, like the accounts page.
    const trigger = row.getByRole("button", { name: /^(Revoke|Actions for) laptop$/ });
    await user.click(trigger);

    if (trigger.getAttribute("aria-haspopup") !== null) {
      await user.click(await screen.findByRole("menuitem", { name: /^Revoke/ }));
    }

    const confirm = await screen.findByRole("alertdialog", { name: "Revoke laptop?" });

    expect(await violations(confirm)).toEqual([]);
  });
});
