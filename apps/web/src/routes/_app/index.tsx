import { createFileRoute, redirect } from "@tanstack/react-router";
import { startPath } from "../../lib/start-page.ts";

// The app's bare address opens the page the viewer chose. Each page has an
// address of its own, so a reload stays where it is.
export const Route = createFileRoute("/_app/")({
  beforeLoad: () => {
    throw redirect({ to: startPath(), replace: true });
  },
});
