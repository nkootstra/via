import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { createKey, startVia, viaHome } from "@via/cli/testing";
import { Effect } from "effect";
import {
  adminKey,
  launchVia,
  openPage,
  signIn,
  startCodex,
  type Via,
  visible,
  withBinary,
} from "./harness.ts";

type Call = {
  method?: string;
  key?: string;
  cookie?: string;
  headers?: Record<string, string>;
  body?: object;
};

/** Calls via's admin API at `path`, with a bearer `key` or a session `cookie`. */
const admin = (url: string, path: string, call: Call = {}) =>
  Effect.promise(() =>
    fetch(`${url}/admin${path}`, {
      method: call.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(call.key !== undefined && { authorization: `Bearer ${call.key}` }),
        ...(call.cookie !== undefined && { cookie: call.cookie }),
        ...call.headers,
      },
      ...(call.body !== undefined && { body: JSON.stringify(call.body) }),
    }),
  );

/** Signs in with `key`: the answer's status, and the session cookie it set, if any. */
const signInWith = (url: string, key: string) =>
  Effect.map(admin(url, "/session", { method: "POST", body: { key } }), (response) => ({
    status: response.status,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  }));

/** Signs in with the admin key and succeeds with the session cookie. */
const session = (url: string) =>
  Effect.gen(function* () {
    const { status, cookie } = yield* signInWith(url, adminKey);
    expect(status).toBe(204);
    expect(cookie).toMatch(/^via_session=/);

    return cookie ?? "";
  });

/** A via that serves the admin API, with one account. */
const viaWithAdmin = Effect.gen(function* () {
  const codex = yield* startCodex;

  return yield* launchVia({
    upstream: codex.url,
    accounts: [{ name: "a" }],
    env: { VIA_ADMIN_KEY: adminKey },
  });
});

/** Creates an API key called `name` with only a session cookie, sending `headers`. */
const createKeyWithCookie = (
  via: Via,
  cookie: string,
  name: string,
  headers: Record<string, string>,
) =>
  Effect.map(
    admin(via.url, "/keys", { method: "POST", cookie, headers, body: { name } }),
    (response) => response.status,
  );

layer(BunFileSystem.layer)("admin sessions", (it) => {
  it.effect("asks a cookie that changes something for the CSRF header and via's own origin", () =>
    Effect.gen(function* () {
      const via = yield* viaWithAdmin;
      const cookie = yield* session(via.url);
      const origin = new URL(via.url).origin;

      expect((yield* admin(via.url, "/keys", { cookie })).status).toBe(200);
      expect(yield* createKeyWithCookie(via, cookie, "no-csrf", { origin })).toBe(403);

      expect(
        yield* createKeyWithCookie(via, cookie, "elsewhere", {
          "x-via-csrf": "1",
          origin: "http://evil.example",
        }),
      ).toBe(403);

      expect(yield* createKeyWithCookie(via, cookie, "laptop", { "x-via-csrf": "1", origin })).toBe(
        201,
      );
    }),
  );

  it.effect("ends a session on sign-out", () =>
    Effect.gen(function* () {
      const via = yield* viaWithAdmin;
      const cookie = yield* session(via.url);

      const signedOut = yield* admin(via.url, "/session", {
        method: "DELETE",
        cookie,
        headers: { "x-via-csrf": "1", origin: new URL(via.url).origin },
      });

      expect(signedOut.status).toBe(204);
      expect((yield* admin(via.url, "/keys", { cookie })).status).toBe(401);
    }),
  );

  it.effect("ends every session when via restarts", () =>
    Effect.gen(function* () {
      const codex = yield* startCodex;

      const { home, env } = yield* viaHome({
        upstream: codex.url,
        env: { VIA_ADMIN_KEY: adminKey },
      });

      yield* createKey(home, "e2e");

      const first = yield* startVia(home, ["--port", "0"], env);
      const cookie = yield* session(first.url);
      yield* first.stop;

      const second = yield* startVia(home, ["--port", "0"], env);
      expect((yield* admin(second.url, "/keys", { cookie })).status).toBe(401);
    }),
  );

  it.effect(
    "refuses an address after 10 wrong keys, the right key and the bearer key included",
    () =>
      Effect.gen(function* () {
        const via = yield* viaWithAdmin;

        // Each wrong key is answered after a second, so they go at once.
        const wrong = yield* Effect.forEach(
          Array.from({ length: 10 }, (_, attempt) => `wrong-key-${attempt}`),
          (key) => Effect.map(signInWith(via.url, key), ({ status }) => status),
          { concurrency: "unbounded" },
        );

        expect(wrong).toEqual(Array.from({ length: 10 }, () => 401));

        const locked = yield* signInWith(via.url, adminKey);
        expect(locked.status).toBe(429);
        expect(locked.cookie).toBeUndefined();

        // The bearer key counts against the same limit, or it would be a way around it.
        expect((yield* admin(via.url, "/keys", { key: adminKey })).status).toBe(429);
      }),
  );

  it.effect.runIf(withBinary)(
    "tells a wrong admin key in the browser, and signs out back to the sign-in page",
    () =>
      Effect.gen(function* () {
        const via = yield* viaWithAdmin;
        const { page, problems } = yield* openPage("sign-out");

        yield* Effect.promise(() => page.goto(`${via.url}/ui/`));
        yield* visible(page, "Sign in");
        yield* Effect.promise(() =>
          page.getByLabel("Admin key").fill("not-the-admin-key-000000000"),
        );
        yield* Effect.promise(() => page.getByRole("button", { name: "Sign in" }).click());

        yield* Effect.promise(() =>
          page.getByRole("alert").getByText("That key isn't right.", { exact: false }).waitFor(),
        );

        yield* signIn(page, via.url);
        yield* Effect.promise(() => page.getByRole("button", { name: "Admin" }).click());
        yield* Effect.promise(() => page.getByRole("menuitem", { name: "Sign out…" }).click());
        yield* visible(page, "Sign out of via?");
        yield* Effect.promise(() => page.getByRole("button", { name: "Sign out" }).click());
        yield* visible(page, "Sign in");

        // The session is gone in via, not just in the page: a deep link asks to sign in.
        yield* Effect.promise(() => page.goto(`${via.url}/ui/keys`));
        yield* visible(page, "Sign in");
        expect(new URL(page.url()).pathname).toBe("/ui/sign-in");

        expect(problems).toEqual([]);
      }),
  );
});
