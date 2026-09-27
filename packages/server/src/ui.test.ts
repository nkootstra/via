import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AdminState } from "./admin-api.ts";
import type { EmbeddedUi } from "./ui.ts";
import { ok, type Via, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

const shell = "<!DOCTYPE html><html><head><title>via</title></head><body></body></html>";

/** A build of the admin UI, as `@via/web/embedded` would give it, in a temp directory. */
const fakeUi = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped();

  const file = (name: string, content: string) =>
    Effect.as(fs.writeFileString(`${dir}/${name}`, content), `${dir}/${name}`);

  return {
    shell: yield* file("_shell.html", shell),
    assets: [
      {
        path: "/ui/assets/index-abc.js",
        file: yield* file("index-abc.js", "console.log('via')"),
        contentType: "text/javascript; charset=utf-8",
      },
      {
        path: "/ui/assets/index-abc.css",
        file: yield* file("index-abc.css", "body{margin:0}"),
        contentType: "text/css; charset=utf-8",
      },
      {
        path: "/ui/favicon.svg",
        file: yield* file("favicon.svg", "<svg/>"),
        contentType: "image/svg+xml",
      },
    ],
    scriptHashes: ["sha256-theme=", "sha256-bootstrap="],
  } satisfies EmbeddedUi;
});

/** Runs `body` against a via with the admin key set, serving the fake UI build. */
const withUi = <A, E>(
  body: (via: Via) => Effect.Effect<A, E>,
  options: { readonly adminKey?: string } = { adminKey },
) => Effect.flatMap(fakeUi, (ui) => withVia(ok, body, { ...options, ui }));

const csp =
  "default-src 'none'; script-src 'self' 'sha256-theme=' 'sha256-bootstrap='; " +
  "style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const secured = {
  "content-security-policy": csp,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Signs in with the admin key, and answers the `Cookie` header that sends its session back. */
const sessionCookie = (via: Via) =>
  Effect.map(
    via.post("/admin/session", { key: adminKey }, null),
    (response) => (response.headers["set-cookie"] ?? "").split("; ")[0] ?? "",
  );

/** The admin state a shell embeds, decoded as the page decodes it. */
const embedded = (html: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AdminState))(
    /<script type="application\/json" id="via-state">(.*?)<\/script>/s.exec(html)?.[1],
  );

layer(BunFileSystem.layer)("the admin UI at /ui", (it) => {
  it.effect("serves the SPA shell at /ui/, uncached, under a strict CSP", () =>
    withUi((via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/ui/", null);

        expect(response.status).toBe(200);
        expect(yield* response.text).toBe(shell);
        expect(response.headers).toMatchObject({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          ...secured,
        });
      }),
    ),
  );

  it.effect("serves the shell for any page, so a deep link or reload works", () =>
    withUi((via) =>
      Effect.gen(function* () {
        for (const path of ["/ui/accounts", "/ui/accounts/a/", "/ui/keys?tab=revoked"]) {
          const response = yield* via.get(path, null);

          expect(response.status).toBe(200);
          expect(yield* response.text).toBe(shell);
        }
      }),
    ),
  );

  it.effect("redirects /ui to /ui/", () =>
    withUi((via) =>
      Effect.gen(function* () {
        const response = yield* via
          .get("/ui", null)
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

        expect(response.status).toBe(302);
        expect(response.headers).toMatchObject({ location: "/ui/", ...secured });
      }),
    ),
  );

  it.effect("serves a hashed asset with its content type, cached for good", () =>
    withUi((via) =>
      Effect.gen(function* () {
        const script = yield* via.get("/ui/assets/index-abc.js", null);

        expect(yield* script.text).toBe("console.log('via')");
        expect(script.headers).toMatchObject({
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          ...secured,
        });

        const style = yield* via.get("/ui/assets/index-abc.css", null);

        expect(yield* style.text).toBe("body{margin:0}");
        expect(style.headers["content-type"]).toBe("text/css; charset=utf-8");
      }),
    ),
  );

  it.effect("serves an unhashed file, which may change, uncached", () =>
    withUi((via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/ui/favicon.svg", null);

        expect(yield* response.text).toBe("<svg/>");
        expect(response.headers).toMatchObject({
          "content-type": "image/svg+xml",
          "cache-control": "no-cache",
        });
      }),
    ),
  );

  it.effect("answers 404 for a missing asset, not the shell a script can't run", () =>
    withUi((via) =>
      Effect.gen(function* () {
        const response = yield* via.get("/ui/assets/index-old.js", null);

        expect(response.status).toBe(404);
        expect(response.headers).toMatchObject(secured);
      }),
    ),
  );

  it.effect("refuses a path that climbs out of /ui", () =>
    withUi((via) =>
      Effect.gen(function* () {
        for (const path of ["/ui/..%2Fadmin%2Fkeys", "/ui/assets/..%2f..%2fetc%2fpasswd"]) {
          const response = yield* via.get(path, null);

          expect(response.status).toBe(400);
          expect(response.headers).toMatchObject(secured);
        }
      }),
    ),
  );

  it.effect("is not served without an admin key, as /admin isn't", () =>
    withUi(
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/ui/", null)).status).toBe(404);
          expect((yield* via.get("/ui/assets/index-abc.js", null)).status).toBe(404);
        }),
      {},
    ),
  );

  it.effect("embeds the admin state in a signed-in page's shell, uncached, for no other", () =>
    withUi((via) =>
      Effect.gen(function* () {
        const cookie = yield* sessionCookie(via);
        const response = yield* via.get("/ui/accounts", null, { cookie });
        const html = yield* response.text;
        const state = yield* embedded(html);

        expect(response.status).toBe(200);
        expect(response.headers).toMatchObject({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          vary: "Cookie",
          ...secured,
        });
        expect(
          html.replace(/<script type="application\/json" id="via-state">.*?<\/script>/s, ""),
        ).toBe(shell);
        expect(state.session).toBe(true);
        expect(state.accounts.map(({ label }) => label)).toEqual([
          "a@example.com",
          "b@example.com",
        ]);
        expect(state.pool.accounts.map((account) => account.state)).toEqual([
          { status: "available" },
          { status: "available" },
        ]);
        expect(state.keys.map(({ name }) => name)).toEqual(["test"]);
        expect(state.opencodeGo.map(({ key }) => key)).toEqual(["…ider"]);
        expect(html).not.toContain("sk-provider");
        expect(html).not.toContain("refreshToken");
        expect(html).not.toContain("accessToken");
      }),
    ),
  );

  it.effect("serves the plain shell without a live session", () =>
    withUi((via) =>
      Effect.gen(function* () {
        for (const headers of [{}, { cookie: "via_session=made-up" }]) {
          const response = yield* via.get("/ui/", null, headers);

          expect(yield* response.text).toBe(shell);
          expect(response.headers).toMatchObject({ "cache-control": "no-cache", vary: "Cookie" });
        }
      }),
    ),
  );

  it.effect("escapes the state so no label can end its script or start another", () =>
    withUi((via) =>
      Effect.gen(function* () {
        const label = "</script><script>alert(1)</script> & <!-- \u2028\u2029";

        const [first] = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ id: Schema.String })),
        )(yield* (yield* via.get("/admin/accounts", adminKey)).json);

        yield* via.patch(`/admin/accounts/${first?.id}`, { label }, adminKey);

        const html = yield* (yield* via.get("/ui/", null, {
          cookie: yield* sessionCookie(via),
        })).text;

        const script = /id="via-state">(.*?)<\/script>/s.exec(html)?.[1] ?? "";

        expect(script).not.toMatch(/[<>&\u2028\u2029]/);
        expect((yield* embedded(html)).accounts[0]?.label).toBe(label);
      }),
    ),
  );

  it.effect("logs a page load, but not the assets it fetches", () =>
    withUi((via) =>
      Effect.gen(function* () {
        yield* via.get("/ui/assets/index-abc.js", null);
        yield* via.get("/ui/favicon.svg", null);
        yield* via.get("/ui/accounts", null);

        expect((yield* via.logged("Sent HTTP response")).annotations).toMatchObject({
          "http.url": "/ui/accounts",
        });
      }),
    ),
  );
});
