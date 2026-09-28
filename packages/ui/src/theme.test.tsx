import { createHash } from "node:crypto";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  Menu,
  MenuContent,
  MenuTrigger,
  ThemeColor,
  ThemeMenuItems,
  themeScript,
  themeScriptHash,
} from "./index.ts";
import { themeColors } from "./palette.ts";
import { setTheme } from "./theme.ts";

const root = document.documentElement;

afterEach(() => {
  localStorage.clear();
  delete root.dataset["theme"];
  root.removeAttribute("style");
  vi.restoreAllMocks();
});

// The shell runs the script as a classic script before anything else.
const runThemeScript = () => new Function(themeScript)();

describe("themeScript", () => {
  it("applies a stored Light or Dark to <html>, with its color-scheme", () => {
    localStorage.setItem("via.theme", "dark");

    runThemeScript();

    expect(root.dataset["theme"]).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("leaves System, and anything it doesn't know, to the OS", () => {
    localStorage.setItem("via.theme", "sepia");

    runThemeScript();

    expect(root.dataset["theme"]).toBeUndefined();
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(runThemeScript).not.toThrow();
    expect(root.dataset["theme"]).toBeUndefined();
  });

  it("is what its CSP hash allows", () => {
    const digest = createHash("sha256").update(themeScript).digest("base64");

    expect(themeScriptHash).toBe(`sha256-${digest}`);
  });
});

/** The theme's items in a menu, as an app's account menu offers them. */
function ThemeMenu() {
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost">Account</Button>} />
      <MenuContent>
        <ThemeMenuItems />
      </MenuContent>
    </Menu>
  );
}

const open = async (user: UserEvent) => {
  await user.click(screen.getByRole("button", { name: "Account" }));

  return screen.findByRole("group", { name: "Theme" });
};

const choose = async (user: UserEvent, theme: string) => {
  const group = await open(user);
  await user.click(within(group).getByRole("menuitemradio", { name: theme }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
};

const checked = (group: HTMLElement, theme: string) =>
  within(group).getByRole("menuitemradio", { name: theme }).getAttribute("aria-checked");

describe("ThemeMenuItems", () => {
  it("offers System, Light and Dark, checking the choice already on <html>", async () => {
    root.dataset["theme"] = "light";
    const user = userEvent.setup();
    render(<ThemeMenu />);

    const group = await open(user);

    expect(within(group).getAllByRole("menuitemradio")).toHaveLength(3);
    expect(checked(group, "Light")).toBe("true");
    expect(checked(group, "System")).toBe("false");
  });

  it("applies and remembers a choice, and System clears it", async () => {
    const user = userEvent.setup();
    render(<ThemeMenu />);

    await choose(user, "Dark");
    expect(root.dataset["theme"]).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("via.theme")).toBe("dark");
    expect(checked(await open(user), "Dark")).toBe("true");
    await user.keyboard("{Escape}");

    await choose(user, "System");
    expect(root.dataset["theme"]).toBeUndefined();
    expect(root.style.colorScheme).toBe("");
    expect(localStorage.getItem("via.theme")).toBeNull();
  });

  it("rerenders nothing else, since the colours change in CSS", async () => {
    const user = userEvent.setup();
    let renders = 0;

    function Sibling() {
      renders += 1;

      return null;
    }

    render(
      <>
        <ThemeMenu />
        <Sibling />
      </>,
    );
    await choose(user, "Dark");
    await choose(user, "Light");

    expect(root.dataset["theme"]).toBe("light");
    expect(renders).toBe(1);
  });

  it("follows a choice made in another tab while it shows", async () => {
    const user = userEvent.setup();
    render(<ThemeMenu />);
    const group = await open(user);

    act(() => {
      localStorage.setItem("via.theme", "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: "via.theme", newValue: "dark" }));
    });

    expect(root.dataset["theme"]).toBe("dark");
    expect(checked(group, "Dark")).toBe("true");
  });
});

/** Every theme-color in the document, as its media and colour, in order. */
const tints = () =>
  [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => [
    meta.getAttribute("media"),
    meta.getAttribute("content"),
  ]);

describe("setTheme", () => {
  it("snaps colours while switching, for two frames", () => {
    const frames: Array<FrameRequestCallback> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      frames.push(callback),
    );
    const nextFrame = () => frames.shift()?.(performance.now());

    setTheme("dark");

    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    nextFrame();
    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    nextFrame();
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
  });
});

describe("ThemeColor", () => {
  it("offers the OS a tint per scheme under System, and a chosen theme's alone", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ThemeColor />
        <ThemeMenu />
      </>,
    );

    expect(tints()).toEqual([
      ["(prefers-color-scheme: light)", themeColors.light],
      ["(prefers-color-scheme: dark)", themeColors.dark],
    ]);

    await choose(user, "Dark");
    expect(tints()).toEqual([[null, themeColors.dark]]);

    await choose(user, "System");
    expect(tints()).toHaveLength(2);
  });
});
