const pad = (n: number) => String(n).padStart(2, "0");

/** A time as `2023-11-14 23:13`, in local time. */
export const localTime = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** How long before `now` a time was: `just now`, `3 min ago`, `5 h ago` or `2 d ago`. */
export const timeAgo = (at: Date, now: number) => {
  const minutes = Math.floor((now - at.getTime()) / 60_000);

  if (minutes < 1) return "just now";

  if (minutes < 60) return `${minutes} min ago`;

  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;

  return `${Math.floor(minutes / 1440)} d ago`;
};
