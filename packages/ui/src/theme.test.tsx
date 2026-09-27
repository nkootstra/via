import { createHash } from "node:crypto";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeSwitch, themeScript, themeScriptHash } from "./index.ts";

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

describe("ThemeSwitch", () => {
  it("is a radio group showing the choice already on <html>", () => {
    root.dataset["theme"] = "light";
    render(<ThemeSwitch />);

    screen.getByRole("radiogroup", { name: "Theme" });
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("applies and remembers a choice, and System clears it", async () => {
    const user = userEvent.setup();
    render(<ThemeSwitch />);

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(root.dataset["theme"]).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("via.theme")).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("radio", { name: "System" }));
    expect(root.dataset["theme"]).toBeUndefined();
    expect(root.style.colorScheme).toBe("");
    expect(localStorage.getItem("via.theme")).toBeNull();
  });

  it("rerenders only itself, since the colours change in CSS", async () => {
    const user = userEvent.setup();
    let renders = 0;

    function Sibling() {
      renders += 1;

      return null;
    }

    render(
      <>
        <ThemeSwitch />
        <Sibling />
      </>,
    );
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(screen.getByRole("radio", { name: "Light" }));

    expect(root.dataset["theme"]).toBe("light");
    expect(renders).toBe(1);
  });

  it("snaps colours while switching, for two frames", async () => {
    const user = userEvent.setup();
    const frames: Array<FrameRequestCallback> = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) =>
      frames.push(callback),
    );
    const nextFrame = () => frames.shift()?.(performance.now());
    render(<ThemeSwitch />);

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    nextFrame();
    expect(root.hasAttribute("data-theme-switching")).toBe(true);
    nextFrame();
    expect(root.hasAttribute("data-theme-switching")).toBe(false);
  });

  it("follows a choice made in another tab", () => {
    render(<ThemeSwitch />);

    act(() => {
      localStorage.setItem("via.theme", "dark");
      window.dispatchEvent(new StorageEvent("storage", { key: "via.theme", newValue: "dark" }));
    });

    expect(root.dataset["theme"]).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
  });
});
