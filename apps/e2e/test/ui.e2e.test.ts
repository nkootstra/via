import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { launchVia, openPage, startCodex } from "./harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

// The browser runs the UI embedded in a compiled binary, as users get it; the
// build job, which has one, installs Chromium for these.
const withBinary = process.env["VIA_E2E_BIN"] !== undefined;

/** A via with one account and the admin key set, so it serves the UI. */
const viaWithUi = Effect.gen(function* () {
  const upstream = yield* startCodex;

  return yield* launchVia({
    upstream: upstream.url,
    accounts: [{ name: "a" }],
    env: { VIA_ADMIN_KEY: adminKey },
  });
});

const visible = (page: Page, name: string) =>
  Effect.promise(() => page.getByRole("heading", { name }).waitFor({ timeout: 10_000 }));

const signIn = (page: Page, url: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.goto(`${url}/ui/`));
    yield* visible(page, "Sign in");
    yield* Effect.promise(() => page.getByLabel("Admin key").fill(adminKey));
    yield* Effect.promise(() => page.getByRole("button", { name: "Sign in" }).click());
    yield* visible(page, "Overview");
  });

layer(BunFileSystem.layer)("the admin UI in a browser", (it) => {
  it.effect.runIf(withBinary)("loads with no console errors or CSP violations", () =>
    Effect.gen(function* () {
      const via = yield* viaWithUi;
      const { page, problems } = yield* openPage("loads");

      yield* Effect.promise(() => page.goto(`${via.url}/ui/`));
      yield* visible(page, "Sign in");

      expect(page.url()).toBe(`${via.url}/ui/sign-in`);
      expect(problems).toEqual([]);
    }),
  );

  it.effect.runIf(withBinary)("signs in with the admin key and shows the overview", () =>
    Effect.gen(function* () {
      const via = yield* viaWithUi;
      const { page, problems } = yield* openPage("signs-in");

      yield* signIn(page, via.url);

      expect(yield* Effect.promise(() => page.getByText("a@example.com").count())).toBeGreaterThan(
        0,
      );
      expect(problems).toEqual([]);
    }),
  );

  it.effect.runIf(withBinary)("reloads a deep link on the same page", () =>
    Effect.gen(function* () {
      const via = yield* viaWithUi;
      const { page, problems } = yield* openPage("deep-link");
      yield* signIn(page, via.url);

      yield* Effect.promise(() => page.goto(`${via.url}/ui/keys`));
      yield* visible(page, "Keys");
      yield* Effect.promise(() => page.reload());
      yield* visible(page, "Keys");

      expect(page.url()).toBe(`${via.url}/ui/keys`);
      expect(problems).toEqual([]);
    }),
  );

  it.effect.runIf(withBinary)("paints a stored dark theme from the first frame", () =>
    Effect.gen(function* () {
      const via = yield* viaWithUi;
      // The OS asks for light, so only the stored choice can make it dark.
      const { page } = yield* openPage("dark-theme", { colorScheme: "light" });

      yield* Effect.promise(() => page.addInitScript(`localStorage.setItem("via.theme", "dark")`));

      // No module runs, so what shows is the shell's inline script and stylesheet
      // alone: what the browser paints before the app starts.
      yield* Effect.promise(() => page.route("**/ui/assets/*.js", (route) => route.abort()));
      yield* Effect.promise(() => page.goto(`${via.url}/ui/`));

      const painted = yield* Effect.promise(() =>
        page.evaluate(`({
          theme: document.documentElement.dataset.theme,
          background: getComputedStyle(document.body).backgroundColor,
        })`),
      );

      expect(painted).toEqual({ theme: "dark", background: "rgb(23, 23, 23)" });
    }),
  );
});
