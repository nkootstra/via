import { useToast } from "@via/ui";
import { useEffect, useEffectEvent } from "react";
import { useViaUpdated } from "../api/live.ts";

/**
 * Once via runs another version than this page was built with, says so until
 * the viewer reloads: the page may not match what via now serves.
 */
export function UpdatePrompt() {
  const updated = useViaUpdated();
  const toast = useToast();

  const prompt = useEffectEvent(() =>
    toast.add({
      title: "via was updated",
      description: "Reload to get the new version.",
      timeout: 0,
      priority: "high",
      actionProps: { children: "Reload", onClick: () => window.location.reload() },
    }),
  );

  useEffect(() => {
    if (updated) prompt();
  }, [updated]);

  return null;
}
