import { createHash } from "node:crypto";
import { act, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeColor, ThemeControl, themeScript, themeScriptHash } from "./index.ts";
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

/** The theme's control, as an app's settings offer it. */
const ThemeSetting = () => <ThemeControl aria-label="Theme" />;

const choose = (user: UserEvent, theme: string) =>
  user.click(screen.getByRole("radio", { name: theme }));

const checked = (theme: string) =>
  screen.getByRole("radio", { name: theme }).getAttribute("aria-checked");

describe("ThemeControl", () => {
  it("offers System, Light and Dark, checking the choice already on <html>", () => {
    root.dataset["theme"] = "light";
    render(<ThemeSetting />);

    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group.querySelectorAll("[role='radio']")).toHaveLength(3);
    expect(checked("Light")).toBe("true");
    expect(checked("System")).toBe("false");
  });

  it("applies and remembers a choice, and System clears it", async () => {
    const user = userEvent.setup();
    render(<ThemeSetting />);

    await choose(user, "Dark");
    expect(root.dataset["theme"]).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("via.theme")).toBe("dark");
    expect(checked("Dark")).toBe("true");

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
        <ThemeSetting />
        <Sibling />
      </>,
    );
    await choose(user, "Dark");
    await choose(user, "Light");

    expect(root.dataset["theme"]).toBe("light");
    expect(renders).toBe(1);
  });

  it("follows a choice made in another tab while it shows", () => {
    render(<ThemeSetting />);

    act(() => {
      localStorage.setItem("via.theme", "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: "via.theme", newValue: "dark" }));
    });

    expect(root.dataset["theme"]).toBe("dark");
    expect(checked("Dark")).toBe("true");
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
        <ThemeSetting />
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
