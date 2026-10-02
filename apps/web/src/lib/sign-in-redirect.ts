/** Any origin will do: it only tells a path on this one from a link elsewhere. */
const HERE = "https://via.invalid";

/**
 * Sign-in's search that brings the viewer back to `href`, a page of the app
 * with its search, such as `/usage?range=7d`; none for the start page.
 */
export const backTo = (href: string) => (href === "/" ? {} : { redirect: href });

/**
 * Whether `href` stays on this app, so sign-in may send the viewer on to it:
 * a path, never a link elsewhere such as `//evil.example` or `/\evil.example`.
 */
export const isAppPath = (href: string) =>
  href.startsWith("/") && URL.parse(href, HERE)?.origin === HERE;
