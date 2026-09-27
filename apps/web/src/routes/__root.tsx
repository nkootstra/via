import "virtual:via-theme.css";
import "../app.css";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { themeScript, ToastProvider } from "@via/ui";
import type { ReactNode } from "react";
import { ErrorScreen } from "../components/error-screen.tsx";

export const Route = createRootRouteWithContext<{ readonly queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "via" },
    ],
  }),
  shellComponent: Shell,
  component: Root,
  errorComponent: ErrorScreen,
});

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    // The theme script sets data-theme and color-scheme on <html> before
    // React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Ahead of the app: a stored theme applies before anything paints. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
        {import.meta.env.DEV && <DevStyleXInject />}
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/**
 * In dev, StyleX's runtime fetches the CSS collected so far and fetches it
 * again as modules compile; a build extracts it into the stylesheet instead.
 */
function DevStyleXInject() {
  return <script type="module" src="/ui/@id/virtual:stylex:runtime" />;
}

function Root() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Outlet />
      </ToastProvider>
    </QueryClientProvider>
  );
}
