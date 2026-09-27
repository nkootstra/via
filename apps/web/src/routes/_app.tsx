import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../api/admin.ts";
import { Dashboard, pageAt } from "../components/app-shell.tsx";

export const Route = createFileRoute("/_app")({
  // Every dashboard page needs a session; without one, sign in and come back. A
  // session the tab kept lets the page paint at once while it is checked again.
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
  component: Dashboard,
});
