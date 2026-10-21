import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, SegmentedControl, SegmentedItem, Switch, ThemeControl, useToast } from "@via/ui";
import { colors, space, text, fontWeights, weights } from "@via/ui/tokens.stylex";
import { useId, useState, type ReactNode } from "react";
import {
  captureQuery,
  clearCapturedPrompts,
  clearHistory,
  refreshHistory,
  setCapture,
} from "../../api/admin.ts";
import { CAPTURE_SETTING } from "../../components/capture-indicator.tsx";
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

/**
 * One setting: its label, at `id` for the control to name itself by, what it
 * does, at `${id}-about` for the control to be described by, and the control.
 */
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
        <p id={`${id}-about`} {...stylex.props(styles.description)}>
          {description}
        </p>
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
          <CaptureSetting />
          <CapturedPromptsSetting />
          <UsageHistorySetting />
        </Panel>
      </Section>
    </Page>
  );
}

/**
 * Whether via keeps the prompts of failed requests, for every viewer: it is
 * via's setting, not this browser's. The switch moves at once and goes back
 * if via refuses.
 */
function CaptureSetting() {
  // The anchor the Conversations tab links to, and the label the switch is named by.
  const label = CAPTURE_SETTING;
  const toast = useToast();
  const queryClient = useQueryClient();
  const capture = useQuery(captureQuery);

  const change = useMutation({
    mutationFn: setCapture,
    onSuccess: (settings) => queryClient.setQueryData(captureQuery.queryKey, settings),
    onError: (error) =>
      toast.add({
        type: "error",
        title: "Couldn't change the setting",
        description: error.message,
      }),
  });

  const on = change.isPending ? change.variables : (capture.data?.keepFailedPrompts ?? false);

  return (
    <Setting
      id={label}
      label="Keep prompts of failed requests"
      description={
        <>
          Off unless you turn it on. When a request fails or falls back, via keeps what the client
          sent and what the upstreams answered for 7 days, so you can see why. Secrets are redacted
          by their pattern first, which can miss some, and images are left out.
        </>
      }
    >
      <Switch
        aria-label="Keep prompts of failed requests"
        aria-describedby={`${label}-about`}
        aria-busy={change.isPending}
        checked={on}
        onCheckedChange={(next) => change.mutate(next)}
      />
    </Setting>
  );
}

/** Deletes every prompt via kept of a failed request; the requests stay in the history. */
function CapturedPromptsSetting() {
  const label = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);

  return (
    <Setting
      id={label}
      label="Delete captured prompts"
      description="Deletes every prompt via kept of a failed request, now. The requests stay in the usage history."
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
        Delete captured prompts…
      </Button>
      {shown && (
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          onClosed={() => setShown(false)}
          title="Delete every captured prompt?"
          description="Every prompt via kept of a failed request goes, and what the upstreams answered to it. The requests stay in the usage history. This can't be undone."
          confirmLabel="Delete prompts"
          confirm={async () => {
            await clearCapturedPrompts();
          }}
          onConfirmed={() => refreshHistory(queryClient)}
          done={{
            title: "Captured prompts deleted",
            description: "via keeps the prompts of new failed requests while the setting is on.",
          }}
          failed="Couldn't delete the captured prompts"
        />
      )}
    </Setting>
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
      description="via keeps each request for 90 days. Deleting starts the Usage page over, and deletes the captured prompts too; keys, accounts and settings stay."
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
