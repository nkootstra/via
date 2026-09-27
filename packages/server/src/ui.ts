import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { RequestLog } from "./request-log.ts";

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

/**
 * The admin UI at `/ui`: the build's files, read into memory once, at their
 * paths, and the SPA shell for every other page, so a deep link or a reload
 * lands on the app, which routes it. A missing file under `/ui/assets/` is a
 * 404 rather than the shell: it's a script or stylesheet a stale page asks
 * for, which HTML can't stand in for.
 */
export const uiRoutes = (ui: EmbeddedUi) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const headers = securityHeaders(ui.scriptHashes);

      const shell = HttpServerResponse.uint8Array(yield* fs.readFile(ui.shell), {
        headers: {
          ...headers,
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
        },
      });

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

          return path.startsWith(HASHED)
            ? HttpServerResponse.empty({ status: 404, headers })
            : shell;
        }),
      );
    }),
  );
