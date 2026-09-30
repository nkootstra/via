import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SegmentedControl, SegmentedItem, Switch, ThemeControl } from "@via/ui";
import { colors, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { useId, useState, type ReactNode } from "react";
import { clearHistory, refreshHistory } from "../../api/admin.ts";
import { ConfirmDialog } from "../../components/confirm-dialog.tsx";
import { TrashIcon } from "../../components/icons.tsx";
import { Page, Panel, Section } from "../../components/page.tsx";
import { setMotion, useMotion } from "../../lib/motion.ts";
import { setPrivacy, usePrivacy } from "../../lib/privacy.ts";
import { setStartPage, useStartPage } from "../../lib/start-page.ts";
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
    // Settings sharing a panel are set apart by a hairline, as a list's rows are.
    paddingTop: { default: 0, ":not(:first-child)": space.s4 },
    marginTop: { default: 0, ":not(:first-child)": space.s4 },
    borderTopWidth: { default: 0, ":not(:first-child)": 1 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
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
  const privacy = usePrivacy();
  const motion = useMotion();
  const start = useStartPage();
  const privacyLabel = useId();
  const themeLabel = useId();
  const motionLabel = useId();
  const formatLabel = useId();
  const startLabel = useId();

  return (
    <Page
      title="Settings"
      description="How the dashboard looks in this browser, and the usage history via keeps."
    >
      <Section title="Privacy">
        <Panel>
          <Setting
            id={privacyLabel}
            label="Privacy mode"
            description="Hides emails, key endings, addresses and codes on screen, for streaming or sharing your screen."
          >
            <Switch aria-label="Privacy mode" checked={privacy} onCheckedChange={setPrivacy} />
          </Setting>
        </Panel>
      </Section>

      <Section title="Appearance">
        <Panel>
          <Setting
            id={themeLabel}
            label="Theme"
            description="System follows your device's light or dark mode."
          >
            <ThemeControl aria-labelledby={themeLabel} />
          </Setting>
          <Setting
            id={motionLabel}
            label="Motion"
            description="System follows your device's reduced motion setting. Reduced holds animations still here whatever it says."
          >
            <SegmentedControl
              aria-labelledby={motionLabel}
              value={motion}
              onValueChange={(value) => setMotion(value === "reduced" ? "reduced" : "system")}
            >
              <SegmentedItem value="system" label="System" />
              <SegmentedItem value="reduced" label="Reduced" />
            </SegmentedControl>
          </Setting>
        </Panel>
      </Section>

      <Section title="Navigation">
        <Panel>
          <Setting
            id={startLabel}
            label="Start page"
            description="The page via opens on when you visit it or sign in."
          >
            <SegmentedControl
              aria-labelledby={startLabel}
              value={start}
              onValueChange={(value) => setStartPage(value === "usage" ? "usage" : "overview")}
            >
              <SegmentedItem value="overview" label="Overview" />
              <SegmentedItem value="usage" label="Usage" />
            </SegmentedControl>
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

      <Section title="Usage history">
        <Panel>
          <UsageHistorySetting />
        </Panel>
      </Section>
    </Page>
  );
}

/**
 * Deletes every request via kept, for every viewer, not only this browser: it
 * asks first, as that can't be undone. Keys, accounts and settings stay.
 */
function UsageHistorySetting() {
  const label = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);

  return (
    <Setting
      id={label}
      label="Delete usage history"
      description="via keeps each request for 90 days. Deleting starts the Usage page over; keys, accounts and settings stay."
    >
      <Button
        variant="secondary"
        aria-describedby={label}
        onClick={() => {
          setShown(true);
          setOpen(true);
        }}
      >
        <TrashIcon size={15} />
        Delete usage history…
      </Button>
      {shown && (
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          onClosed={() => setShown(false)}
          title="Delete all usage history?"
          description="Every request via kept goes: its tokens, cost and errors, for every key and account. This can't be undone."
          confirmLabel="Delete history"
          confirm={async () => {
            await clearHistory();
          }}
          onConfirmed={() => refreshHistory(queryClient)}
          done={{
            title: "Usage history deleted",
            description: "via keeps recording new requests from now on.",
          }}
          failed="Couldn't delete the usage history"
        />
      )}
    </Setting>
  );
}
