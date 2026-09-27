import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { embed, renderApp } from "./app.tsx";
import { openSource } from "./event-source.ts";

afterEach(() => vi.restoreAllMocks());

/** The state of a via with no accounts yet, as version `version`. */
const stateOf = (version: string) =>
  ({
    session: true,
    version,
    pool: { accounts: [], opencodeGo: [], providers: [] },
    usage: { accounts: [], opencodeGo: [], refreshing: false },
    accounts: [],
    opencodeGo: [],
    keys: [],
    models: [],
  }) as const;

/** The version this page was built with: the repository's, in tests. */
const built = "0.0.0";

describe("a via updated under the page", () => {
  it("offers to reload once via says it runs another version, and only once", async () => {
    embed(stateOf(built));
    renderApp("/");
    await screen.findByRole("heading", { name: "Overview", level: 1 });

    act(() => openSource().push(stateOf(built)));
    expect(screen.queryByText("via was updated")).toBeNull();

    // via restarted on a new build, and the browser reconnected to it.
    act(() => openSource().fail());
    act(() => openSource().push(stateOf("9.9.9")));
    act(() => openSource().push(stateOf("9.9.9")));

    // An urgent toast is announced from a live region; happy-dom can't tell the
    // visible one apart, so the button is found wherever it is.
    const button = await screen.findByRole("button", { name: "Reload", hidden: true });
    expect(screen.getAllByRole("button", { name: "Reload", hidden: true })).toHaveLength(1);
    expect(screen.getAllByText("Reload to get the new version.").length).toBeGreaterThan(0);

    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload });
    act(() => button.click());
    expect(reload).toHaveBeenCalledOnce();
  });
});
