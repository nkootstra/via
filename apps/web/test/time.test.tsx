import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ago,
  countdown,
  formatTime,
  formatTimestamp,
  providerWindowName,
  timeAgo,
  useNow,
  windowName,
} from "../src/lib/time.ts";

const minute = 60_000;

const hour = 60 * minute;

const day = 24 * hour;

describe("countdown", () => {
  it("counts minutes and seconds under an hour, rounding a part-second up", () => {
    expect(countdown(0)).toBe("0:00");
    expect(countdown(4 * minute + 6_001)).toBe("4:07");
  });

  it("counts hours and minutes under a day", () => {
    expect(countdown(2 * hour + 5 * minute)).toBe("2 h 05 min");
  });

  it("counts days and hours beyond", () => {
    expect(countdown(3 * day + 4 * hour + 10 * minute)).toBe("3 d 4 h");
  });

  it("never counts below zero", () => {
    expect(countdown(-5_000)).toBe("0:00");
  });
});

describe("windowName", () => {
  it("names a day, a week and 30 days as OpenCode Go's windows are named", () => {
    expect(windowName(1_440)).toBe("Daily");
    expect(windowName(10_080)).toBe("Weekly");
    expect(windowName(43_200)).toBe("Monthly");
  });

  it("names other whole days and hours, one or many", () => {
    expect(windowName(2_880)).toBe("2 days");
    expect(windowName(60)).toBe("1 hour");
    expect(windowName(300)).toBe("5 hours");
  });

  it("gives anything else in minutes", () => {
    expect(windowName(90)).toBe("90 minutes");
    expect(windowName(1)).toBe("1 minute");
  });
});

describe("providerWindowName", () => {
  it("names OpenCode Go's windows, and gives any other as it came", () => {
    expect(providerWindowName("rolling")).toBe("5 hours");
    expect(providerWindowName("weekly")).toBe("Weekly");
    expect(providerWindowName("daily")).toBe("daily");
  });
});

describe("ago", () => {
  it("reads mid-sentence, to the second: just now, then seconds, minutes, hours, days", () => {
    expect(ago(4_999)).toBe("just now");
    expect(ago(40_000)).toBe("40 s ago");
    expect(ago(3 * minute + 59_000)).toBe("3 min ago");
    expect(ago(5 * hour)).toBe("5 h ago");
    expect(ago(2 * day + 3 * hour)).toBe("2 d ago");
  });

  it("says just now for a time a little ahead", () => {
    expect(ago(-2_000)).toBe("just now");
  });
});

describe("timeAgo", () => {
  it("stands alone, to the minute: Just now, then minutes, hours, days", () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");

    expect(timeAgo("2026-09-27T11:59:30.000Z", now)).toBe("Just now");
    expect(timeAgo("2026-09-27T11:57:00.000Z", now)).toBe("3 min ago");
    expect(timeAgo("2026-09-27T07:00:00.000Z", now)).toBe("5 h ago");
    expect(timeAgo("2026-09-25T09:00:00.000Z", now)).toBe("2 d ago");
  });
});

// 15:05 on the machine's clock, wherever the tests run.
const afternoon = new Date(2026, 8, 27, 15, 5, 9).toISOString();

describe("formatTime", () => {
  it("writes the hour as the time format asks: 24-hour, or 12-hour", () => {
    expect(formatTime(afternoon, "24h")).toContain("15:05");
    expect(formatTime(afternoon, "12h")).toContain("3:05");
    expect(formatTime(afternoon, "12h")).not.toContain("15:05");
  });

  it("leaves the hour to the viewer's locale on Automatic", () => {
    const locale = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

    expect(formatTime(afternoon, "auto")).toContain(locale.format(new Date(afternoon)));
  });
});

describe("formatTimestamp", () => {
  it("writes the hour as the time format asks, to the second", () => {
    expect(formatTimestamp(afternoon, "24h")).toContain("15:05:09");
    expect(formatTimestamp(afternoon, "12h")).toContain("3:05:09");
  });
});

function Clock({ name, interval = 1_000 }: { readonly name: string; readonly interval?: number }) {
  return <span data-testid={name}>{useNow(interval)}</span>;
}

const shown = (name: string) => screen.getByTestId(name).textContent;

describe("useNow", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse("2026-09-27T12:00:00.000Z") }));

  afterEach(() => vi.useRealTimers());

  it("ticks every clock of one interval together, on one timer", () => {
    const first = render(<Clock name="a" />);
    act(() => vi.advanceTimersByTime(400));
    render(<Clock name="b" />);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(600));
    expect(shown("a")).toBe(String(Date.parse("2026-09-27T12:00:01.000Z")));
    expect(shown("b")).toBe(shown("a"));

    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps a timer per interval, and stops each once nothing asks for it", () => {
    const seconds = render(<Clock name="a" />);
    const minutes = render(<Clock name="b" interval={minute} />);

    expect(vi.getTimerCount()).toBe(2);

    seconds.unmount();
    expect(vi.getTimerCount()).toBe(1);
    minutes.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
