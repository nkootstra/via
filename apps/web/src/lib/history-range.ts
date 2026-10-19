import type { HistoryRange } from "../api/admin.ts";

const HOUR = 3_600_000;

/**
 * The last `days` of the usage history, up to the end of the current hour, or
 * of today on the viewer's clock, as its bars are an hour or a day wide. Days
 * are counted on the calendar, so a range of them starts at local midnight
 * even across a change to or from summer time.
 */
export const historyRange = (days: number, bucket: "hour" | "day", now: number): HistoryRange => {
  const end = new Date(now);

  if (bucket === "hour") {
    end.setMinutes(60, 0, 0);

    return { from: end.getTime() - days * 24 * HOUR, to: end.getTime() };
  }

  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - days);

  return { from: start.getTime(), to: end.getTime() };
};

/**
 * When each of the range's hours or days starts, as the server buckets them in
 * the viewer's time zone: a real hour each, and a day from one local midnight
 * to the next, 23 or 25 hours when the clocks change.
 */
export const historyBuckets = (range: HistoryRange, bucket: "hour" | "day") => {
  const starts: Array<number> = [];

  for (const at = new Date(range.from); at.getTime() < range.to;) {
    starts.push(at.getTime());

    if (bucket === "hour") {
      at.setTime(at.getTime() + HOUR);
    } else {
      at.setDate(at.getDate() + 1);
    }
  }

  return starts;
};
