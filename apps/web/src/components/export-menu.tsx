/**
 * Exporting a conversation, from its header: as a JSON file, or as a Markdown
 * report on the clipboard. Both take the prompts via kept of its failed
 * turns, fetched as the menu opens, and the menu says so once when they do,
 * as a prompt may hold what its redaction missed.
 */
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  ChevronDownIcon,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  useToast,
} from "@via/ui";
import { colors, space, text } from "@via/ui/tokens.stylex";
import { Option } from "effect";
import { capturedRequestQuery } from "../api/admin.ts";
import type { CapturedRequest, Conversation } from "../api/types.ts";
import {
  conversationJson,
  conversationMarkdown,
  exportFileName,
} from "../lib/conversation-export.ts";
import { useMask } from "../lib/privacy.ts";
import { formatMoment } from "../lib/time.ts";
import { useTimeFormat } from "../lib/time-format.ts";
import { formatCount } from "../lib/usage-format.ts";
import { builtVersion } from "../version.ts";
import { DocumentIcon, DownloadIcon } from "./icons.tsx";

const styles = stylex.create({
  note: {
    maxWidth: "17rem",
    margin: 0,
    marginTop: space.s1,
    paddingBlock: space.s2,
    paddingInline: space.s2_5,
    borderTop: `1px solid ${colors.border}`,
    fontSize: text.caption,
    lineHeight: 1.45,
    color: colors.mutedForeground,
  },
});

type Kind = "json" | "markdown";

/** Saves `contents` as a file named `name`, as the browser saves a download. */
const download = (name: string, contents: string) => {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

export function ExportMenu({ conversation }: { readonly conversation: Conversation }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const mask = useMask();
  const format = useTimeFormat();
  const count = conversation.captured.length;

  const bodies = () =>
    Promise.all(
      conversation.captured.map((requestId) =>
        queryClient
          .fetchQuery(capturedRequestQuery(requestId))
          .then((found) =>
            Option.map(found, (body): readonly [string, CapturedRequest] => [requestId, body]),
          ),
      ),
    ).then((found) => new Map(found.flatMap(Option.toArray)));

  const exporting = useMutation({
    mutationFn: (kind: Kind) =>
      bodies().then((captured) =>
        kind === "json"
          ? download(
              exportFileName(conversation.summary.id, new Date()),
              JSON.stringify(
                conversationJson(conversation, captured, {
                  exportedAt: new Date(),
                  version: builtVersion,
                }),
                null,
                2,
              ),
            )
          : navigator.clipboard.writeText(
              conversationMarkdown(conversation, captured, {
                time: (at) => formatMoment(at, format),
                hide: mask.key,
              }),
            ),
      ),
    onSuccess: (_, kind) =>
      toast.add(
        kind === "json"
          ? { title: "Conversation downloaded" }
          : { title: "Markdown copied", description: "A report of the conversation, to paste." },
      ),
    onError: (error) =>
      toast.add({
        type: "error",
        title: "Couldn't export the conversation",
        description: error.message,
      }),
  });

  return (
    <Menu
      onOpenChange={(open) => {
        // Fetched as the menu opens, so the copy that follows a pick is quick.
        if (open) {
          for (const requestId of conversation.captured) {
            void queryClient.prefetchQuery(capturedRequestQuery(requestId));
          }
        }
      }}
    >
      <MenuTrigger
        render={
          <Button variant="secondary" size="compact" loading={exporting.isPending}>
            <DownloadIcon size={14} />
            Export
            <ChevronDownIcon size={14} />
          </Button>
        }
      />
      <MenuContent align="end">
        <MenuItem
          label="Download JSON"
          icon={<DownloadIcon size={15} />}
          onClick={() => exporting.mutate("json")}
        />
        <MenuItem
          label="Copy as Markdown"
          icon={<DocumentIcon size={15} />}
          onClick={() => exporting.mutate("markdown")}
        />
        {count > 0 && (
          <p {...stylex.props(styles.note)}>
            Holds {formatCount(count)} captured {count === 1 ? "prompt" : "prompts"}. via redacts
            secrets by their pattern, which can miss some: read it before you share it.
          </p>
        )}
      </MenuContent>
    </Menu>
  );
}
