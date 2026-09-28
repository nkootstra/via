import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeFormat, useTimeFormat } from "../src/lib/time-format.ts";

afterEach(() => {
  act(() => setTimeFormat("auto"));
  localStorage.clear();
  vi.restoreAllMocks();
});

function Shown() {
  return <span data-testid="format">{useTimeFormat()}</span>;
}

const shown = () => screen.getByTestId("format").textContent;

describe("the time format", () => {
  it("is Automatic until the viewer chooses", () => {
    render(<Shown />);

    expect(shown()).toBe("auto");
  });

  it("applies a choice at once and remembers it, and Automatic forgets it", () => {
    render(<Shown />);

    act(() => setTimeFormat("24h"));
    expect(shown()).toBe("24h");
    expect(localStorage.getItem("via.time-format")).toBe("24h");

    act(() => setTimeFormat("auto"));
    expect(shown()).toBe("auto");
    expect(localStorage.getItem("via.time-format")).toBeNull();
  });

  it("reads a stored choice, and ignores one it doesn't know", () => {
    localStorage.setItem("via.time-format", "12h");
    const first = render(<Shown />);
    expect(shown()).toBe("12h");
    first.unmount();

    localStorage.setItem("via.time-format", "36h");
    render(<Shown />);
    expect(shown()).toBe("auto");
  });

  it("follows a choice made in another tab", () => {
    render(<Shown />);

    act(() => {
      localStorage.setItem("via.time-format", "24h");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "via.time-format", newValue: "24h" }),
      );
    });

    expect(shown()).toBe("24h");
  });

  it("lasts as long as the page when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Shown />);

    act(() => setTimeFormat("12h"));

    expect(shown()).toBe("12h");
  });
});
