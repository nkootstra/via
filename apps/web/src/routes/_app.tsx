import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../api/admin.ts";
import { useLiveUpdates } from "../api/live.ts";
import { Dashboard, pageAt } from "../components/app-shell.tsx";
import { UpdatePrompt } from "../components/update-prompt.tsx";

export const Route = createFileRoute("/_app")({
  // Every dashboard page needs a session; without one, sign in and come back. A
  // session the shell vouched for lets the page paint at once.
  beforeLoad: async ({ context, location }) => {
    if (
      !(await context.queryClient.ensureQueryData({ ...sessionQuery, revalidateIfStale: true }))
    ) {
      const back = pageAt(location.pathname);

      throw redirect({
        to: "/sign-in",
        search: back === undefined || back === "/" ? {} : { redirect: back },
      });
    }
  },
  component: SignedIn,
});

/**
 * The dashboard, kept live from `/admin/events` for as long as it's open, and
 * told when via was updated under it.
 */
function SignedIn() {
  useLiveUpdates();

  return (
    <>
      <Dashboard />
      <UpdatePrompt />
    </>
  );
}
