import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { SegmentedControl, SegmentedItem, ThemeControl } from "@via/ui";
import { colors, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { useId, type ReactNode } from "react";
import { Page, Panel, Section } from "../../components/page.tsx";
import { formatTime } from "../../lib/time.ts";
import { setTimeFormat, useTimeFormat, type TimeFormat } from "../../lib/time-format.ts";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings · via" }] }),
  component: Settings,
});

const styles = stylex.create({
  // The control sits beside its label while both fit, and drops below it when not.
  setting: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space.s6,
    rowGap: space.s3,
  },
  about: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    flexBasis: "240px",
    gap: space.s1,
    minWidth: 0,
  },
  label: {
    fontSize: text.body,
    fontVariationSettings: weights.medium,
    fontWeight: fontWeights.medium,
    color: colors.foreground,
  },
  description: {
    margin: 0,
    fontSize: text.caption,
    lineHeight: 1.5,
    color: colors.mutedForeground,
  },
  control: { maxWidth: "100%" },
});

/** One setting: its label, at `id` for the control to name itself by, what it does, and the control. */
function Setting({
  id,
  label,
  description,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.setting)}>
      <div {...stylex.props(styles.about)}>
        <span id={id} {...stylex.props(styles.label)}>
          {label}
        </span>
        <p {...stylex.props(styles.description)}>{description}</p>
      </div>
      <div {...stylex.props(styles.control)}>{children}</div>
    </div>
  );
}

const timeFormats: ReadonlyArray<{ readonly value: TimeFormat; readonly label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "12h", label: "12-hour" },
  { value: "24h", label: "24-hour" },
];

const isTimeFormat = (value: string): value is TimeFormat =>
  timeFormats.some((format) => format.value === value);

// An afternoon, so 12-hour and 24-hour read differently: Monday 5 January, 15:30.
const sample = new Date(2026, 0, 5, 15, 30).toISOString();

function Settings() {
  const format = useTimeFormat();
  const themeLabel = useId();
  const formatLabel = useId();

  return (
    <Page title="Settings" description="How the dashboard looks in this browser.">
      <Section title="Appearance">
        <Panel>
          <Setting
            id={themeLabel}
            label="Theme"
            description="System follows your device's light or dark mode."
          >
            <ThemeControl aria-labelledby={themeLabel} />
          </Setting>
        </Panel>
      </Section>

      <Section title="Dates and times">
        <Panel>
          <Setting
            id={formatLabel}
            label="Time format"
            description={`Automatic follows your browser's language. Times read like ${formatTime(sample, format)}.`}
          >
            <SegmentedControl
              aria-labelledby={formatLabel}
              value={format}
              onValueChange={(value) => {
                if (isTimeFormat(value)) setTimeFormat(value);
              }}
            >
              {timeFormats.map((option) => (
                <SegmentedItem key={option.value} value={option.value} label={option.label} />
              ))}
            </SegmentedControl>
          </Setting>
        </Panel>
      </Section>
    </Page>
  );
}
