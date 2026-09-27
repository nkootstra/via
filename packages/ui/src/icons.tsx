/** The few glyphs the components draw, as 24-unit stroke icons (Lucide's geometry). */
interface IconProps {
  readonly size: number;
}

const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function XIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} {...stroke}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function CopyIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} {...stroke}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

export function CheckIcon({ size }: IconProps) {
  return (
    <svg width={size} height={size} {...stroke}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
