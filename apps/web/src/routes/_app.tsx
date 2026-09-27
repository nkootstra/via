import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionQuery } from "../api/admin.ts";
import { Dashboard, pageAt } from "../components/app-shell.tsx";

export const Route = createFileRoute("/_app")({
  // Every dashboard page needs a session; without one, sign in and come back.
  beforeLoad: async ({ context, location }) => {
    if (!(await context.queryClient.fetchQuery(sessionQuery))) {
      const back = pageAt(location.pathname);

      throw redirect({
        to: "/sign-in",
        search: back === undefined || back === "/" ? {} : { redirect: back },
      });
    }
  },
  component: Dashboard,
});
