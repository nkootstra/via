import "virtual:via-theme.css";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { themeScript } from "@via/ui";
import type { ReactNode } from "react";

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
  component: Outlet,
});

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    // The theme script sets data-theme and color-scheme on <html> before
    // React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* First in the head: a stored theme applies before anything paints. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
