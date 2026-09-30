import { screen, waitFor, within } from "@testing-library/react";
import { Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { account, type AdminState, opencodeGoAccount } from "../src/testing/admin-handlers.ts";
import { breakdown, group, request } from "../src/testing/history.ts";
import { renderApp } from "./app.tsx";

afterEach(() => localStorage.clear());

/** What identifies the viewer: none of it may reach the page, attributes included. */
const secrets = [
  "niels@work.example",
  "you@home.example",
  "…1234",
  "…9f3a",
  "192.168.1.20",
  "upstream@leak.example",
];

const seed: Partial<AdminState> = {
  // A ChatGPT account is labelled by its email until it's renamed.
  accounts: [
    account({ id: "acc-1", label: "niels@work.example", email: "niels@work.example", plan: "pro" }),
    account({ id: "acc-2", label: "home", email: "you@home.example" }),
  ],
  opencodeGo: [opencodeGoAccount({ id: "go-1", label: "OpenCode Go …1234", key: "…1234" })],
  pool: {
    accounts: [
      { id: "acc-1", label: "niels@work.example", enabled: true, state: { status: "available" } },
      {
        id: "acc-2",
        label: "home",
        enabled: true,
        state: { status: "auth_error", reason: "you@home.example was signed out" },
      },
    ],
    opencodeGo: [
      { id: "go-1", label: "OpenCode Go …1234", enabled: true, state: { status: "available" } },
    ],
    providers: [],
  },
  ollama: { address: "http://192.168.1.20:11434", fromConfig: false },
  openrouter: { key: "…9f3a", models: [], fromConfig: false },
  historyBreakdown: new Map([
    [
      "account",
      breakdown([
        group({ group: "acc-1", label: "niels@work.example" }),
        group({ group: "acc-2", label: "home" }),
      ]),
    ],
  ]),
  historyRequests: [
    request({
      requestId: "r-1",
      accountLabel: Option.some("niels@work.example"),
      status: 401,
      error: Option.some("unauthorized"),
      errorMessage: Option.some("Token for upstream@leak.example expired"),
    }),
  ],
};

/** The page's whole markup, attributes included. */
const markup = () => document.body.innerHTML;

describe("privacy mode", () => {
  it.each([
    ["/", "Overview"],
    ["/accounts", "Accounts"],
    ["/usage?by=account", "Usage"],
  ])("hides what identifies the viewer on %s", async (path, heading) => {
    localStorage.setItem("via.privacy", "on");
    renderApp(path, seed);

    await screen.findByRole("heading", { name: heading, level: 1 });
    // Wait for what loads after the page paints.
    await waitFor(() => expect(markup()).toContain("•••••@•••••.example"));

    for (const secret of secrets) expect(markup()).not.toContain(secret);
  });

  it("shows it all while off", async () => {
    renderApp("/accounts", seed);

    expect(await screen.findByText("you@home.example")).toBeDefined();
    expect(markup()).toContain("…1234");
    expect(markup()).toContain("192.168.1.20");
  });

  it("hides a name in a dialog and the toast that follows", async () => {
    localStorage.setItem("via.privacy", "on");
    const { user } = renderApp("/accounts", seed);

    const table = await screen.findByRole("table", { name: "ChatGPT accounts" });
    await user.click(within(table).getAllByRole("button", { name: /^Actions for / })[0] ?? table);
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    await screen.findByRole("alertdialog");

    for (const secret of secrets) expect(markup()).not.toContain(secret);
  });

  it("conceals a new API key until the viewer shows it", async () => {
    localStorage.setItem("via.privacy", "on");
    const { user } = renderApp("/keys");

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const form = await screen.findByRole("dialog", { name: "Create a key" });
    await user.type(within(form).getByLabelText("Name"), "laptop");
    await user.click(within(form).getByRole("button", { name: "Create key" }));

    const reveal = await screen.findByRole("dialog", { name: "Your new key: laptop" });
    const shown = within(reveal).getByRole("button", { name: "Show API key" });
    expect(markup()).not.toContain("0123456789abcdef");
    await user.click(shown);
    expect(within(reveal).getByText(/0123456789abcdef/)).toBeDefined();
  });
});
