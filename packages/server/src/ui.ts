import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AdminState } from "./admin-api.ts";
import { AdminSessions } from "./admin-sessions.ts";
import { adminState, type StateOptions } from "./admin-state.ts";
import { RequestLog } from "./request-log.ts";
import { hasLiveSession } from "./session-cookie.ts";

/** The admin UI's build, as `@via/web/embedded` gives it: files on disk, or in the binary. */
export type EmbeddedUi = {
  /** The SPA shell, served for every page under `/ui`. */
  readonly shell: string;
  /** Every other file of the build, with the URL path it's served at. */
  readonly assets: ReadonlyArray<{
    readonly path: string;
    readonly file: string;
    readonly contentType: string;
  }>;
  /** The CSP sources (`sha256-…`) of the shell's inline scripts. */
  readonly scriptHashes: ReadonlyArray<string>;
};

/**
 * Headers for every `/ui` response. The CSP lets the page run only its own
 * scripts and the shell's inline ones, style itself only from its stylesheet
 * (or by script, through the CSSOM), and talk only to via.
 */
const securityHeaders = (scriptHashes: ReadonlyArray<string>) => ({
  "content-security-policy": [
    "default-src 'none'",
    ["script-src 'self'", ...scriptHashes.map((hash) => `'${hash}'`)].join(" "),
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});

/** Files under here have a content hash in their name, so they never change. */
const HASHED = "/ui/assets/";

/**
 * A path that climbs up a directory, however it's spelled. No page or file of
 * the UI needs an encoded dot, slash or backslash, so those are refused outright.
 */
const climbs = (path: string) => /(^|\/)\.\.(\/|$)|%2e|%2f|%5c|\\/i.test(path);

const encodeState = Schema.encodeEffect(Schema.fromJsonString(AdminState));

/**
 * JSON as the text of an HTML `<script>`: `<`, `>` and `&` escaped, so no string
 * in it can end the script or open a comment, and U+2028 and U+2029, which some
 * parsers take for line ends. JSON reads each escape back as the same character.
 */
const inScript = (json: string) =>
  json.replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Whether `request` carries a live session's cookie, which counts as using the session. */
const signedIn = (
  sessions: AdminSessions["Service"],
  request: HttpServerRequest.HttpServerRequest,
) => hasLiveSession(sessions, request);

/**
 * The admin UI at `/ui`: the build's files, read into memory once, at their
 * paths, and the SPA shell for every other page, so a deep link or a reload
 * lands on the app, which routes it. A missing file under `/ui/assets/` is a
 * 404 rather than the shell: it's a script or stylesheet a stale page asks
 * for, which HTML can't stand in for. A signed-in page's shell carries the
 * admin state, so the page paints it without asking via for anything.
 */
export const uiRoutes = (ui: EmbeddedUi, options: StateOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The admin API's sessions, which the admin routes provide to this layer only.
      const sessions = yield* AdminSessions;
      const headers = securityHeaders(ui.scriptHashes);
      const html = yield* fs.readFileString(ui.shell);
      // Which shell a page gets depends on its cookie, so a cache must tell them apart.
      const page = { ...headers, "content-type": "text/html; charset=utf-8", vary: "Cookie" };

      const shell = HttpServerResponse.text(html, {
        headers: { ...page, "cache-control": "no-cache" },
      });

      /**
       * The shell with `state` in it, as inert JSON the app reads before its first
       * render. The state is the viewer's, so no cache may keep it.
       */
      const withState = (state: string) =>
        HttpServerResponse.text(
          // A function, so a `$&` or `` $` `` in the state is text, not a replacement pattern.
          html.replace(
            "</head>",
            () =>
              `<script type="application/json" id="via-state">${inScript(state)}</script></head>`,
          ),
          { headers: { ...page, "cache-control": "no-store" } },
        );

      const assets = new Map(
        yield* Effect.forEach(ui.assets, ({ path, file, contentType }) =>
          Effect.map(fs.readFile(file), (body) => {
            const response = HttpServerResponse.uint8Array(body, {
              headers: {
                ...headers,
                "content-type": contentType,
                "cache-control": path.startsWith(HASHED)
                  ? "public, max-age=31536000, immutable"
                  : "no-cache",
              },
            });

            return [path, response] as const;
          }),
        ),
      );

      return HttpRouter.add("GET", "/ui/*", (request) =>
        Effect.gen(function* () {
          const [path = ""] = request.url.split("?", 1);

          if (path === "/ui") return HttpServerResponse.redirect("/ui/", { headers });

          if (climbs(path)) return HttpServerResponse.empty({ status: 400, headers });
          const asset = assets.get(path);

          // A page load fetches every file; its one line in the log is the shell's.
          if (asset !== undefined) return yield* Effect.as((yield* RequestLog).unlogged, asset);

          if (path.startsWith(HASHED)) return HttpServerResponse.empty({ status: 404, headers });

          if (!(yield* signedIn(sessions, request))) return shell;

          // via builds the state itself, so failing to encode it is a bug.
          return withState(yield* Effect.orDie(Effect.flatMap(adminState(options), encodeState)));
        }),
      );
    }),
  );
