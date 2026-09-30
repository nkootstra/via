import type { HistoryRange } from "../api/admin.ts";

const DAY = 86_400_000;

/**
 * The last `days` of the usage history, up to the end of the current hour, or
 * of today on the viewer's clock, as its bars are an hour or a day wide.
 */
export const historyRange = (days: number, bucket: "hour" | "day", now: number): HistoryRange => {
  const end = new Date(now);

  if (bucket === "hour") {
    end.setMinutes(60, 0, 0);
  } else {
    end.setHours(24, 0, 0, 0);
  }

  const to = end.getTime();

  return { from: to - days * DAY, to };
};
