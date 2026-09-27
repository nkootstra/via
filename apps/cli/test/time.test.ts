import { describe, expect, it } from "@effect/vitest";
import { timeAgo } from "../src/time.ts";

describe("timeAgo", () => {
  const now = Date.UTC(2024, 0, 10, 12);
  const before = (ms: number) => timeAgo(new Date(now - ms), now);

  it("rounds down to the largest whole unit", () => {
    expect(before(59_999)).toBe("just now");
    expect(before(60_000)).toBe("1 min ago");
    expect(before(59 * 60_000 + 59_999)).toBe("59 min ago");
    expect(before(60 * 60_000)).toBe("1 h ago");
    expect(before(23 * 3_600_000 + 59 * 60_000)).toBe("23 h ago");
    expect(before(3 * 86_400_000)).toBe("3 d ago");
  });
});
