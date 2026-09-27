import { describe, expect, it } from "vitest";
import { pickNearest } from "./fluid-hover.tsx";

// Three 32px rows with 4px gaps: 0–32, 36–68, 72–104.
const rows = [0, 36, 72].map((top) => ({ top, left: 0, width: 200, height: 32 }));

describe("pickNearest", () => {
  it("picks the row the pointer is inside", () => {
    expect(pickNearest("y", { x: 10, y: 40 }, rows)).toBe(1);
  });

  it("lights the nearest row from a gap, the padding, or past the end", () => {
    expect(pickNearest("y", { x: 10, y: 33 }, rows)).toBe(0);
    expect(pickNearest("y", { x: 10, y: 35 }, rows)).toBe(1);
    expect(pickNearest("y", { x: 10, y: -6 }, rows)).toBe(0);
    expect(pickNearest("y", { x: 10, y: 400 }, rows)).toBe(2);
  });

  it("measures along x for a horizontal strip", () => {
    const tabs = [0, 80, 160].map((left) => ({ top: 0, left, width: 72, height: 28 }));

    expect(pickNearest("x", { x: 90, y: 500 }, tabs)).toBe(1);
    expect(pickNearest("x", { x: 77, y: 0 }, tabs)).toBe(1);
  });

  it("skips unregistered slots and has nothing to pick from none", () => {
    expect(pickNearest("y", { x: 0, y: 40 }, [undefined, undefined])).toBeNull();
    expect(pickNearest("y", { x: 0, y: 40 }, [rows[0], undefined, rows[2]])).toBe(0);
  });
});
