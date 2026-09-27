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
