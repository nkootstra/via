/**
 * A waterfall's time axis: ticks at round steps (1, 2 or 5 of a unit, and the
 * clock's 15 and 30 for seconds and minutes) placed so their labels never
 * collide, and where a bar's own label fits beside it.
 */

/** The least room a tick's label needs, centre to centre, in pixels. */
export const MIN_TICK_GAP_PX = 88;

/** The most steps an axis is cut into, however wide: more reads as noise. */
const MAX_STEPS = 8;

const SECOND = 1_000;

const MINUTE = 60 * SECOND;

const HOUR = 60 * MINUTE;

const CLOCK = [1, 2, 5, 10, 15, 30];

/** The round steps under an hour, smallest first. */
const STEPS = [
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  200,
  500,
  ...CLOCK.map((n) => n * SECOND),
  ...CLOCK.map((n) => n * MINUTE),
];

/** Whether `ms` is one of the axis's round steps. */
export const isRoundStep = (ms: number) => {
  if (STEPS.includes(ms)) return true;

  const hours = ms / HOUR;
  const magnitude = 10 ** Math.floor(Math.log10(hours));

  return Number.isInteger(hours) && [1, 2, 5].includes(hours / magnitude);
};

/** The smallest round step of at least `ms`: past an hour, 1, 2 or 5 × 10ⁿ hours. */
const roundUp = (ms: number) => {
  const step = STEPS.find((candidate) => candidate >= ms);

  if (step !== undefined) return step;

  const hours = ms / HOUR;
  const magnitude = 10 ** Math.floor(Math.log10(hours));
  const leading = [1, 2, 5, 10].find((n) => n * magnitude >= hours) ?? 10;

  return leading * magnitude * HOUR;
};

/**
 * The finest round step that cuts a span of `spanMs`, drawn `widthPx` wide,
 * into at most eight steps whose labels each have room. A track too narrow for
 * even one step gets a step past its span.
 */
export const axisStep = (spanMs: number, widthPx: number) =>
  roundUp(
    Math.min(
      Math.max(spanMs / MAX_STEPS, widthPx > 0 ? (spanMs * MIN_TICK_GAP_PX) / widthPx : Infinity),
      // Past the span one step is as good as any: the axis shows its start alone.
      spanMs + 1,
    ),
  );

/** The ticks of a span of `spanMs`, drawn `widthPx` wide: offsets from its start. */
export const axisTicks = (spanMs: number, widthPx: number): ReadonlyArray<number> => {
  const step = axisStep(spanMs, widthPx);

  return Array.from({ length: Math.floor(spanMs / step) + 1 }, (_, index) => index * step);
};

/** Each unit a label may use, largest first, and whether its steps may be tenths of it. */
const UNITS: ReadonlyArray<readonly [number, string, boolean]> = [
  [HOUR, "h", true],
  // "0.5 min" reads worse than "30 s".
  [MINUTE, "min", false],
  [SECOND, "s", true],
  [1, "ms", false],
];

/**
 * The ticks' labels, all in one unit: the largest the last tick reaches in
 * which each step is whole, or a tenth of a second or an hour: "0.5 s", "30 s",
 * "2 min", "1.5 h". The start is "0".
 */
export const formatTicks = (ticks: ReadonlyArray<number>, stepMs: number) => {
  const last = ticks.at(-1) ?? 0;

  const [unit, name] = UNITS.find(
    ([size, , tenths]) =>
      size === 1 ||
      (last >= size && Number.isInteger(Number(((stepMs * (tenths ? 10 : 1)) / size).toFixed(6)))),
  ) ?? [1, "ms"];

  return ticks.map((ms) => (ms === 0 ? "0" : `${Number((ms / unit).toFixed(3))} ${name}`));
};

/** About how wide a caption's figures are, a character each, in pixels. */
const CHAR_PX = 7;

/** The gap between a bar and its label, in pixels. */
export const LABEL_GAP_PX = 6;

/**
 * Where a bar's label goes: after its end when there's room, else before its
 * start, else inside it, for a bar that fills its track.
 */
export const labelPlacement = (
  bar: { readonly start: number; readonly end: number },
  widthPx: number,
  label: string,
): "after" | "before" | "inside" => {
  const needs = label.length * CHAR_PX + LABEL_GAP_PX;

  return (1 - bar.end) * widthPx >= needs
    ? "after"
    : bar.start * widthPx >= needs
      ? "before"
      : "inside";
};
