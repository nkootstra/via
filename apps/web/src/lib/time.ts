import { useCallback, useSyncExternalStore } from "react";

/** One clock per interval, shared by every component that asks for it. */
interface Ticker {
  readonly listeners: Set<() => void>;
  now: number;
  timer?: ReturnType<typeof setInterval>;
}

const tickers = new Map<number, Ticker>();

/** The ticker for `interval`, started by the first component to subscribe. */
const tickerFor = (interval: number) => {
  const found = tickers.get(interval);

  if (found !== undefined) return found;
  const created: Ticker = { listeners: new Set(), now: Date.now() };
  tickers.set(interval, created);

  return created;
};

/**
 * The current time, ticking every `interval` ms; only the components that ask
 * rerender, and all that ask for one interval tick together, on one timer that
 * runs while any of them is mounted.
 */
export function useNow(interval = 1_000) {
  const subscribe = useCallback(
    (onTick: () => void) => {
      const ticker = tickerFor(interval);
      ticker.listeners.add(onTick);

      ticker.timer ??= setInterval(() => {
        ticker.now = Date.now();

        for (const listener of ticker.listeners) listener();
      }, interval);

      return () => {
        ticker.listeners.delete(onTick);

        if (ticker.listeners.size === 0) {
          clearInterval(ticker.timer);
          tickers.delete(interval);
        }
      };
    },
    [interval],
  );

  // Reads only: a render that never commits leaves no ticker behind.
  return useSyncExternalStore(subscribe, () => tickers.get(interval)?.now ?? Date.now());
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * How long ago something was, `ms` since, to the second and in lower case to
 * read mid-sentence ("Updated just now"): "just now", "40 s ago", "3 min ago",
 * "2 h ago", "2 d ago". `timeAgo` is its counterpart for a value on its own.
 */
export function ago(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));

  if (seconds < 5) return "just now";

  if (seconds < 60) return `${seconds} s ago`;

  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min ago`;

  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h ago`;

  return `${Math.floor(seconds / 86_400)} d ago`;
}

/** A countdown to go: `4:07` under an hour, `2 h 05 min` under a day, then `3 d 4 h`. */
export function countdown(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (hours === 0) return `${minutes}:${pad(seconds % 60)}`;

  if (days === 0) return `${hours} h ${pad(minutes % 60)} min`;

  return `${days} d ${hours % 24} h`;
}

/** The windows OpenCode Go names, named the same for any provider: 10080 minutes → "Weekly". */
const namedWindows = new Map([
  [1_440, "Daily"],
  [10_080, "Weekly"],
  [43_200, "Monthly"],
]);

/** A rate limit window's name: 300 minutes → "5 hours", 10080 → "Weekly". */
export function windowName(minutes: number) {
  const named = namedWindows.get(minutes);

  if (named !== undefined) return named;

  if (minutes % 1_440 === 0) return `${minutes / 1_440} ${minutes === 1_440 ? "day" : "days"}`;

  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;

  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** The names OpenCode Go gives its usage windows, as the overview shows them. */
const providerWindows = new Map([
  ["rolling", "5 hours"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
]);

/** A provider's usage window's name: OpenCode Go's `rolling` → "5 hours"; others as given. */
export const providerWindowName = (window: string) => providerWindows.get(window) ?? window;

/**
 * How long before `now` a time was, to the minute and capitalised to stand on
 * its own, as in a table cell: "Just now", "3 min ago", "5 h ago", "2 d ago".
 */
export function timeAgo(iso: string, now: number) {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);

  if (minutes < 1) return "Just now";

  if (minutes < 60) return `${minutes} min ago`;

  if (minutes < 1_440) return `${Math.floor(minutes / 60)} h ago`;

  return `${Math.floor(minutes / 1_440)} d ago`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const timestampFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** A date, as the viewer's locale writes it. */
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));

/** A date and time to the second, as the viewer's locale writes it. */
export const formatTimestamp = (iso: string) => timestampFormat.format(new Date(iso));

/** A clock time with its weekday, for a reset or a cooldown's end. */
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));
