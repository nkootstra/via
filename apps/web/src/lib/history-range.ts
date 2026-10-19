import type { HistoryRange } from "../api/admin.ts";

const HOUR = 3_600_000;

/** Every time zone's clocks change on a quarter hour. */
const SLOT = 15 * 60_000;

/** `n` modulo `size`, never negative. */
const modulo = (n: number, size: number) => ((n % size) + size) % size;

/** How far ahead of UTC the viewer's clock is at `at`, in milliseconds. */
const offsetAt = (at: number) => -new Date(at).getTimezoneOffset() * 60_000;

/** The first quarter hour after `from`, up to `to`, where the viewer's clock changes; `to` without one. */
const changeAfter = (from: number, to: number) => {
  const offset = offsetAt(from);
  let at = from - modulo(from, SLOT) + SLOT;

  while (at < to && offsetAt(at) === offset) at += SLOT;

  return Math.min(at, to);
};

/**
 * When the hour that holds `at` starts, as the server has it: on the hour of
 * the viewer's clock, or when the clock changed, so a change of half an hour
 * leaves a half hour.
 */
const hourStart = (at: number) => {
  const offset = offsetAt(at);
  const onTheHour = at - modulo(at + offset, HOUR);

  return offsetAt(onTheHour) === offset ? onTheHour : changeAfter(onTheHour, at);
};

/** When the hour after the one starting at `start` starts. */
const nextHour = (start: number) => {
  const offset = offsetAt(start);
  const onTheHour = start + HOUR - modulo(start + offset, HOUR);

  return offsetAt(onTheHour) === offset ? onTheHour : changeAfter(start, onTheHour);
};

/**
 * The last `days` of the usage history, up to the end of the current hour, or
 * of today on the viewer's clock, as its bars are an hour or a day wide. Days
 * are counted on the calendar, so a range of them starts at local midnight
 * even across a change to or from summer time, and a range of hours starts
 * when its first hour does.
 */
export const historyRange = (days: number, bucket: "hour" | "day", now: number): HistoryRange => {
  if (bucket === "hour") {
    const to = nextHour(hourStart(now));

    return { from: hourStart(to - days * 24 * HOUR), to };
  }

  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - days);

  return { from: start.getTime(), to: end.getTime() };
};

/**
 * When each of the range's hours or days starts, as the server buckets them in
 * the viewer's time zone: an hour on the hour of the clock, the one a clock
 * repeats too, and a day from one local midnight to the next, 23 or 25 hours
 * when the clocks change.
 */
export const historyBuckets = (range: HistoryRange, bucket: "hour" | "day") => {
  const starts: Array<number> = [];

  for (const at = new Date(range.from); at.getTime() < range.to;) {
    starts.push(at.getTime());

    if (bucket === "hour") {
      at.setTime(nextHour(at.getTime()));
    } else {
      at.setDate(at.getDate() + 1);
    }
  }

  return starts;
};
