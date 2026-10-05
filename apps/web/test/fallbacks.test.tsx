import { act, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { FallbackRuleInvalidError } from "@via/fallbacks/rule";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { Fallback } from "../src/api/types.ts";
import { type AdminState, failure } from "../src/testing/admin-handlers.ts";
import { embed, fakeClock, renderApp, skip } from "./app.tsx";
import { openSource } from "./event-source.ts";

const model = (id: string) => ({ id, object: "model", created: 0, owned_by: "via" });

const models = [
  model("gpt-5.6-sol"),
  model("gpt-5.6-sol-low"),
  model("gpt-5.6-sol-high"),
  model("gpt-5.5"),
  model("gpt-5.5-high"),
  model("opencode-go/kimi-k3"),
  model("openrouter/minimax-m3"),
];

const available = { status: "available" } as const;

/** A rule whose model answers its own requests, every fallback standing by. */
const standingBy = (source: string, fallbacks: ReadonlyArray<string>): Fallback => ({
  model: source,
  fallbacks,
  status: { source: available, fallbacks: fallbacks.map(() => available), serving: source },
});

const now = Date.parse("2026-09-27T12:00:00.000Z");

/** Cooling down for `ms` from `now`, rate limited. */
const cooling = (ms: number) =>
  ({
    status: "cooling",
    until: new Date(now + ms).toISOString(),
    reason: "rate_limited",
  }) as const;

/** A rule whose model cools down for `ms`, so its first fallback answers. */
const fallingBack = (source: string, fallbacks: ReadonlyArray<string>, ms: number): Fallback => ({
  model: source,
  fallbacks,
  status: {
    source: cooling(ms),
    fallbacks: fallbacks.map(() => available),
    serving: fallbacks[0] ?? null,
  },
});

/** The state via puts in a signed-in page's shell, and pushes as it changes, with `fallbacks`. */
const viaState = (fallbacks: ReadonlyArray<Fallback>) =>
  ({
    session: true,
    version: "0.0.0",
    pool: { accounts: [], opencodeGo: [], providers: [] },
    usage: { accounts: [], opencodeGo: [], openrouter: null, refreshing: false },
    accounts: [],
    opencodeGo: [],
    keys: [],
    models,
    ollama: null,
    openrouter: null,
    fallbacks,
  }) as const;

/** The row of the rule for `source`. */
const rowOf = (source: string) => screen.findByRole("article", { name: source });

/** The models a row falls back to, in order, as it names them. */
const chainOf = (row: HTMLElement) =>
  within(within(row).getByRole("list", { name: "Falls back to" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

describe("the fallbacks page", () => {
  it("lists each rule as its model and the models it falls back to, in order", async () => {
    renderApp("/fallbacks", {
      models,
      fallbacks: [standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3", "gpt-5.5"])],
    });

    const row = await rowOf("gpt-5.6-sol");

    expect(chainOf(row)).toEqual(["kimi-k3", "gpt-5.5"]);
  });

  it("says there are no fallbacks yet, and what one does", async () => {
    renderApp("/fallbacks", { models });

    const empty = await screen.findByRole("region", { name: "No fallbacks yet" });

    expect(empty.textContent).toContain(
      "Add one, and when a model is cooling down or out of reach, via answers with another you choose instead of an error.",
    );
  });

  it("announces that the fallbacks are loading", async () => {
    fakeClock();
    renderApp("/fallbacks", { models }, [http.get("*/admin/fallbacks", () => delay("infinite"))]);

    // The router shows it once loading takes a moment, 1 s.
    await skip(1_000);
    expect((await screen.findByRole("status")).textContent).toBe("Loading fallbacks…");
  });

  it("says the fallbacks couldn't be loaded, rather than that there are none", async () => {
    const { user } = renderApp(
      "/fallbacks",
      { models, fallbacks: [standingBy("gpt-5.6-sol", ["gpt-5.5"])] },
      [
        http.get("*/admin/fallbacks", () => new HttpResponse(null, { status: 500 }), {
          once: true,
        }),
      ],
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load fallbacks");
    expect(screen.getByRole("heading", { level: 1, name: "Fallbacks" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "No fallbacks yet" })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await rowOf("gpt-5.6-sol")).toBeDefined();
  });

  it("says a rule whose model answers is standing by", async () => {
    renderApp("/fallbacks", { models, fallbacks: [standingBy("gpt-5.6-sol", ["gpt-5.5"])] });

    expect(within(await rowOf("gpt-5.6-sol")).getByText("Standing by")).toBeDefined();
  });

  it("says a rule is falling back, to which model, why and until when, counting down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    renderApp("/fallbacks", {
      models,
      fallbacks: [fallingBack("gpt-5.6-sol", ["opencode-go/kimi-k3", "gpt-5.5"], 247_000)],
    });

    const row = await rowOf("gpt-5.6-sol");

    const [serving] = within(within(row).getByRole("list", { name: "Falls back to" })).getAllByRole(
      "listitem",
    );

    expect(within(row).getByText("Falling back")).toBeDefined();
    expect(serving?.querySelector("[aria-current='true']")?.textContent).toContain("kimi-k3");
    expect(serving?.textContent).toContain("answering now");
    expect(row.textContent).toContain("Rate limited");
    expect(row.textContent).toContain("Back in 4:07");
    expect(row.textContent).toMatch(/Ends \w+/);

    await act(() => vi.advanceTimersByTimeAsync(3_000));

    expect(row.textContent).toContain("Back in 4:04");
  });

  it("says a model with no account to serve it falls back for that", async () => {
    renderApp("/fallbacks", {
      models,
      fallbacks: [
        {
          ...standingBy("gpt-5.6-sol", ["gpt-5.5"]),
          status: {
            source: { status: "unavailable", reason: "no_accounts" },
            fallbacks: [available],
            serving: "gpt-5.5",
          },
        },
      ],
    });

    expect((await rowOf("gpt-5.6-sol")).textContent).toContain("No account can serve it");
  });

  it("notes each fallback via can't use, and why", async () => {
    renderApp("/fallbacks", {
      models,
      fallbacks: [
        {
          ...standingBy("gpt-5.6-sol", ["openrouter/minimax-m3", "opencode-go/kimi-k3", "gpt-4o"]),
          status: {
            source: available,
            fallbacks: [
              { status: "unavailable", reason: "not_enabled" },
              { status: "unavailable", reason: "no_accounts" },
              available,
            ],
            serving: "gpt-5.6-sol",
          },
        },
      ],
    });

    const row = await rowOf("gpt-5.6-sol");

    expect(row.textContent).toContain("minimax-m3 isn't enabled, so via skips it.");
    expect(row.textContent).toContain("kimi-k3 has no account to serve it, so via skips it.");
    expect(row.textContent).toContain("gpt-4o isn't in the models list, so via skips it.");
  });

  it("says when no model in a rule's list can answer either", async () => {
    renderApp("/fallbacks", {
      models,
      fallbacks: [
        {
          ...fallingBack("gpt-5.6-sol", ["gpt-5.5"], 60_000),
          status: { source: cooling(60_000), fallbacks: [cooling(60_000)], serving: null },
        },
      ],
    });

    const row = await rowOf("gpt-5.6-sol");
    expect(within(row).getByText("No fallback available")).toBeDefined();
    expect(row.textContent).toContain(
      "Every model in the list is unavailable too, so requests fail.",
    );
    expect(row.textContent).toContain("Rate limited");
  });

  it("renders the rules the shell carries, asking via for nothing", async () => {
    embed(viaState([standingBy("gpt-5.6-sol", ["gpt-5.5"])]));
    const { state } = renderApp("/fallbacks", { models });

    expect(chainOf(await rowOf("gpt-5.6-sol"))).toEqual(["gpt-5.5"]);
    expect(state.requests).toEqual([]);
  });

  it("announces when a rule starts or stops falling back, and nothing else", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    embed(viaState([standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3"])]));
    renderApp("/fallbacks", { models });
    await rowOf("gpt-5.6-sol");
    const status = screen.getByRole("status");

    expect(status.textContent).toBe("");

    act(() =>
      openSource().push(viaState([fallingBack("gpt-5.6-sol", ["opencode-go/kimi-k3"], 60_000)])),
    );
    await waitFor(() => expect(status.textContent).toBe("gpt-5.6-sol is falling back to kimi-k3."));

    // The countdown ticks, which is no news.
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(status.textContent).toBe("gpt-5.6-sol is falling back to kimi-k3.");

    act(() => openSource().push(viaState([standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3"])])));
    await waitFor(() => expect(status.textContent).toBe("gpt-5.6-sol is answering again."));
  });

  it("announces when no model in a rule's list can answer", async () => {
    embed(viaState([standingBy("gpt-5.6-sol", ["gpt-5.5"])]));
    renderApp("/fallbacks", { models });
    await rowOf("gpt-5.6-sol");

    act(() =>
      openSource().push(
        viaState([
          {
            ...standingBy("gpt-5.6-sol", ["gpt-5.5"]),
            status: { source: cooling(60_000), fallbacks: [cooling(60_000)], serving: null },
          },
        ]),
      ),
    );

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "gpt-5.6-sol has no fallback available, so its requests fail.",
      ),
    );
  });

  it("is in the navigation, after Models", async () => {
    renderApp("/fallbacks", { models });

    const nav = within(await screen.findByRole("navigation", { name: "Pages" }));
    const links = nav.getAllByRole("link");
    const modelsAt = links.indexOf(nav.getByRole("link", { name: "Models" }));

    expect(links[modelsAt + 1]).toBe(nav.getByRole("link", { name: "Fallbacks" }));
  });
});

/** Opens a picker in `scope` by its name, and picks the option that reads `label`. */
async function pick(user: UserEvent, scope: HTMLElement, picker: RegExp | string, label: string) {
  await user.click(within(scope).getByRole("combobox", { name: picker }));
  await user.click(await screen.findByRole("option", { name: new RegExp(`^${label}`) }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

/** The dialog's list of models to fall back to, as it names them. */
const editorChain = (dialog: HTMLElement) =>
  within(within(dialog).getByRole("list", { name: "Fall back to, in order" }))
    .queryAllByRole("listitem")
    // A model's name holds its full id as its title.
    .map((item) => item.querySelector("[title]")?.textContent);

/** The rules the fake via keeps, without how they stand. */
const rulesIn = (state: AdminState) =>
  state.fallbacks.map((rule) => ({ model: rule.model, fallbacks: rule.fallbacks }));

/** Opens the add dialog from the page's header, or its empty state. */
async function openAdd(user: UserEvent) {
  const [add] = await screen.findAllByRole("button", { name: "Add fallback" });
  await user.click(add!);

  return screen.findByRole("dialog", { name: "Add a fallback" });
}

/** An error toast, as it's announced: Base UI reads it out through an alert. */
const errorToast = (title: string) =>
  waitFor(() =>
    expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.startsWith(title))).toBe(
      true,
    ),
  );

describe("adding a fallback", () => {
  it("adds a model and the models it falls back to, in order", async () => {
    const { state, user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    expect(
      within(dialog).getByRole("combobox", { name: "Fall back from: gpt-5.6-sol" }),
    ).toBeDefined();
    await pick(user, dialog, "Add model", "kimi-k3");
    await pick(user, dialog, "Add model", "gpt-5.5");
    expect(editorChain(dialog)).toEqual(["kimi-k3", "gpt-5.5"]);

    await user.click(within(dialog).getByRole("button", { name: "Add fallback" }));

    // By name: the "Fallback added" toast is a dialog too.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add a fallback" })).toBeNull(),
    );
    expect(rulesIn(state)).toEqual([
      { model: "gpt-5.6-sol", fallbacks: ["opencode-go/kimi-k3", "gpt-5.5"] },
    ]);
    expect(chainOf(await rowOf("gpt-5.6-sol"))).toEqual(["kimi-k3", "gpt-5.5"]);
    expect((await screen.findByRole("dialog", { name: "Fallback added" })).textContent).toContain(
      "When gpt-5.6-sol can't answer, via tries kimi-k3, then gpt-5.5.",
    );
  });

  it("asks for a model to fall back from, at the picker", async () => {
    const { user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await user.click(within(dialog).getByRole("button", { name: "Add fallback" }));

    const picker = within(dialog).getByRole("combobox", { name: "Fall back from" });
    expect(picker.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(picker.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Choose a model to fall back from.");
    expect(document.activeElement).toBe(picker);
  });

  it("asks for at least one model to fall back to", async () => {
    const { state, user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await user.click(within(dialog).getByRole("button", { name: "Add fallback" }));

    const add = within(dialog).getByRole("combobox", { name: "Add model" });
    expect(document.getElementById(add.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Add at least one model to fall back to.",
    );
    expect(document.activeElement).toBe(add);
    expect(state.requests).not.toContain("PUT /admin/fallbacks");
  });

  it("offers a model that already has a fallback, but not to pick", async () => {
    const { user } = renderApp("/fallbacks", {
      models,
      fallbacks: [standingBy("gpt-5.5", ["opencode-go/kimi-k3"])],
    });

    const dialog = await openAdd(user);
    await user.click(within(dialog).getByRole("combobox", { name: "Fall back from" }));
    const taken = await screen.findByRole("option", { name: /^gpt-5\.5/ });

    expect(taken.getAttribute("aria-disabled")).toBe("true");
    expect(taken.textContent).toContain("Has a fallback");
  });

  it("groups the models by who serves them, Codex first, with their efforts", async () => {
    const { user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await user.click(within(dialog).getByRole("combobox", { name: "Fall back from" }));
    await screen.findByRole("listbox");

    const groups = screen.getAllByRole("group");

    expect(groups[0]).toBe(screen.getByRole("group", { name: "Codex" }));
    expect(
      within(screen.getByRole("group", { name: "Codex" })).getAllByRole("option"),
    ).toHaveLength(2);
    expect(screen.getByRole("group", { name: "OpenCode Go" })).toBeDefined();
    expect(screen.getByRole("option", { name: /^gpt-5\.6-sol/ }).textContent).toContain(
      "low · high",
    );
  });

  it("moves a model up and down the list, focus following it, and says where it went", async () => {
    const { user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await pick(user, dialog, "Add model", "kimi-k3");
    await pick(user, dialog, "Add model", "gpt-5.5");
    await pick(user, dialog, "Add model", "minimax-m3");

    await user.click(within(dialog).getByRole("button", { name: "Move minimax-m3 up" }));

    expect(editorChain(dialog)).toEqual(["kimi-k3", "minimax-m3", "gpt-5.5"]);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Move minimax-m3 up" }),
    );
    expect(within(dialog).getByRole("status").textContent).toBe("Moved minimax-m3 up, to 2 of 3.");

    await user.click(within(dialog).getByRole("button", { name: "Move minimax-m3 up" }));

    expect(editorChain(dialog)).toEqual(["minimax-m3", "kimi-k3", "gpt-5.5"]);
    // First now, it can only go down: focus goes there rather than to a button that can't move it.
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Move minimax-m3 down" }),
    );

    await user.keyboard("{Enter}");

    expect(editorChain(dialog)).toEqual(["kimi-k3", "minimax-m3", "gpt-5.5"]);
    expect(within(dialog).getByRole("status").textContent).toBe(
      "Moved minimax-m3 down, to 2 of 3.",
    );
  });

  it("removes a model from the list, focus moving to the next", async () => {
    const { user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await pick(user, dialog, "Add model", "kimi-k3");
    await pick(user, dialog, "Add model", "gpt-5.5");

    await user.click(within(dialog).getByRole("button", { name: "Remove kimi-k3" }));

    expect(editorChain(dialog)).toEqual(["gpt-5.5"]);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Remove gpt-5.5" }),
    );
    expect(within(dialog).getByRole("status").textContent).toBe("Removed kimi-k3.");

    await user.click(within(dialog).getByRole("button", { name: "Remove gpt-5.5" }));

    expect(editorChain(dialog)).toEqual([]);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("combobox", { name: "Add model" }),
    );
  });

  it("offers neither the model itself nor one already in the list", async () => {
    const { user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await pick(user, dialog, "Add model", "kimi-k3");
    await user.click(within(dialog).getByRole("combobox", { name: "Add model" }));
    await screen.findByRole("listbox");

    expect(screen.queryByRole("option", { name: /^gpt-5\.6-sol/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /^kimi-k3/ })).toBeNull();
    expect(screen.getByRole("option", { name: /^gpt-5\.5/ })).toBeDefined();
  });

  it("takes at most three models to fall back to", async () => {
    const { user } = renderApp("/fallbacks", { models: [...models, model("gpt-5.4")] });

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await pick(user, dialog, "Add model", "kimi-k3");
    await pick(user, dialog, "Add model", "gpt-5.5");
    await pick(user, dialog, "Add model", "minimax-m3");

    expect(within(dialog).queryByRole("combobox", { name: "Add model" })).toBeNull();
    expect(dialog.textContent).toContain(
      "That's the most: a model falls back to at most 3 others.",
    );
    // Add model went with the third pick, so focus goes to the model it added.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("button", { name: "Remove minimax-m3" }),
      ),
    );
  });

  it("hints what a request with an effort gets from a model without it", async () => {
    const { user } = renderApp("/fallbacks", { models });

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await pick(user, dialog, "Add model", "kimi-k3");

    expect(dialog.textContent).toContain(
      "kimi-k3 has no reasoning efforts: a request for gpt-5.6-sol-high gets it at its default.",
    );
  });

  it("shows why via refused the rule at the list, and stays open", async () => {
    const { user } = renderApp("/fallbacks", { models }, [
      http.put(
        "*/admin/fallbacks",
        () =>
          failure(
            FallbackRuleInvalidError,
            new FallbackRuleInvalidError({ problem: "A model id is at most 200 characters" }),
            400,
          ),
        { once: true },
      ),
    ]);

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await pick(user, dialog, "Add model", "kimi-k3");
    await user.click(within(dialog).getByRole("button", { name: "Add fallback" }));

    expect(await within(dialog).findByText("A model id is at most 200 characters.")).toBeDefined();
    expect(screen.getByRole("dialog", { name: "Add a fallback" })).toBeDefined();
  });

  it("says when the fallback couldn't be saved, and stays open", async () => {
    const { user } = renderApp("/fallbacks", { models }, [
      http.put("*/admin/fallbacks", () => new HttpResponse(null, { status: 500 }), { once: true }),
    ]);

    const dialog = await openAdd(user);
    await pick(user, dialog, "Fall back from", "gpt-5.6-sol");
    await pick(user, dialog, "Add model", "kimi-k3");
    await user.click(within(dialog).getByRole("button", { name: "Add fallback" }));

    await errorToast("Couldn't save fallback");
    expect(screen.getByRole("dialog", { name: "Add a fallback" })).toBeDefined();
  });
});

/** Opens a row's actions and picks `action`. */
async function rowAction(user: UserEvent, source: string, action: string) {
  await user.click(
    within(await rowOf(source)).getByRole("button", { name: `Actions for ${source}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: action }));
}

describe("editing a fallback", () => {
  it("changes the list of a rule, its model fixed", async () => {
    const { state, user } = renderApp("/fallbacks", {
      models,
      fallbacks: [standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3", "gpt-5.5"])],
    });

    await rowAction(user, "gpt-5.6-sol", "Edit…");
    const dialog = await screen.findByRole("dialog", { name: "Edit the fallback for gpt-5.6-sol" });

    expect(within(dialog).queryByRole("combobox", { name: /^Fall back from/ })).toBeNull();
    expect(editorChain(dialog)).toEqual(["kimi-k3", "gpt-5.5"]);

    await user.click(within(dialog).getByRole("button", { name: "Remove kimi-k3" }));
    await user.click(within(dialog).getByRole("button", { name: "Save fallback" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Edit the fallback for gpt-5.6-sol" }),
      ).toBeNull(),
    );
    expect(rulesIn(state)).toEqual([{ model: "gpt-5.6-sol", fallbacks: ["gpt-5.5"] }]);
    expect(await screen.findByRole("dialog", { name: "Fallback saved" })).toBeDefined();
  });
});

describe("editing a fallback, again", () => {
  it("starts from the saved list when opened again straight after a cancel", async () => {
    const { user } = renderApp("/fallbacks", {
      models,
      fallbacks: [standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3", "gpt-5.5"])],
    });

    await rowAction(user, "gpt-5.6-sol", "Edit…");

    const first = await screen.findByRole("dialog", { name: "Edit the fallback for gpt-5.6-sol" });

    await user.click(within(first).getByRole("button", { name: "Remove kimi-k3" }));

    // The dialog animates out for as long as a browser's animation runs: here, until it is let go.
    const animating = vi
      .spyOn(Element.prototype, "getAnimations")
      .mockImplementation(() => [
        Object.assign(new Animation(), { finished: new Promise<Animation>(() => {}) }),
      ]);

    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    // While it is on its way out.
    await rowAction(user, "gpt-5.6-sol", "Edit…");

    animating.mockRestore();

    await waitFor(() =>
      expect(
        editorChain(screen.getByRole("dialog", { name: "Edit the fallback for gpt-5.6-sol" })),
      ).toEqual(["kimi-k3", "gpt-5.5"]),
    );
  });
});

describe("removing a fallback", () => {
  it("asks first, then removes the rule", async () => {
    const { state, user } = renderApp("/fallbacks", {
      models,
      fallbacks: [standingBy("gpt-5.6-sol", ["opencode-go/kimi-k3"])],
    });

    await rowAction(user, "gpt-5.6-sol", "Remove…");

    const confirm = await screen.findByRole("alertdialog", {
      name: "Remove the fallback for gpt-5.6-sol?",
    });

    expect(confirm.textContent).toContain(
      "When gpt-5.6-sol can't answer, its requests fail again instead of going to kimi-k3.",
    );

    await user.click(within(confirm).getByRole("button", { name: "Remove fallback" }));

    expect(await screen.findByRole("dialog", { name: "Fallback removed" })).toBeDefined();
    expect(state.fallbacks).toEqual([]);
    expect(await screen.findByRole("region", { name: "No fallbacks yet" })).toBeDefined();
  });
});
