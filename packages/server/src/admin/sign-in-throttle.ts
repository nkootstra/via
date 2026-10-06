/** How many failed sign-ins are allowed, and within how long, in millis. */
export interface Limits {
  /** Failures from one client within `window` after which it is refused. */
  readonly perClient: number;
  /** Failures from all clients within `window` after which everyone is refused. */
  readonly total: number;
  readonly window: number;
}

/**
 * A client is refused after 10 failures in a minute. Everyone is refused after
 * 1000, a backstop against guessing from many addresses at once: locking out the
 * admin's browser takes 100 addresses rather than one. Each failure is kept at
 * most a minute, so the failures kept, and the clients they are kept for, stay
 * under 1000.
 */
export const SIGN_IN_LIMITS: Limits = { perClient: 10, total: 1000, window: 60_000 };

/** Failed sign-ins by client: the epoch millis of each, oldest first, never empty. */
export type Failures = ReadonlyMap<string, ReadonlyArray<number>>;

/** A sign-in from `client` at `now`, with the right key if `matches`. */
interface Attempt {
  readonly client: string;
  readonly now: number;
  readonly matches: boolean;
}

type Outcome = "ok" | "wrong" | "throttled";

/**
 * The outcome of a sign-in, and the failures after it. A refused sign-in is not
 * counted. A successful one leaves its client's failures to run out: behind a proxy
 * the admin shares an address with whoever guesses, whose count it must not reset.
 */
export const attempt = (
  limits: Limits,
  failures: Failures,
  { client, now, matches }: Attempt,
): readonly [Outcome, Failures] => {
  const recent = new Map<string, ReadonlyArray<number>>();

  for (const [id, times] of failures) {
    const kept = times.filter((at) => now - at < limits.window);

    if (kept.length > 0) recent.set(id, kept);
  }

  const own = recent.get(client) ?? [];
  const total = [...recent.values()].reduce((sum, times) => sum + times.length, 0);

  if (own.length >= limits.perClient || total >= limits.total) return ["throttled", recent];

  if (matches) return ["ok", recent];

  return ["wrong", recent.set(client, [...own, now])];
};
