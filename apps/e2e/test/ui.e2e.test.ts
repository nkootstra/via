import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";
import { reply } from "@via/codex-upstream/testing";
import { launchVia, openPage, post, startCodex } from "./harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

// The browser runs the UI embedded in a compiled binary, as users get it; the
// build job, which has one, installs Chromium for these.
const withBinary = process.env["VIA_E2E_BIN"] !== undefined;

/** A via with one account and the admin key set, so it serves the UI, and its fake Codex. */
const viaAndCodex = Effect.gen(function* () {
  const codex = yield* startCodex;

  const via = yield* launchVia({
    upstream: codex.url,
    accounts: [{ name: "a" }],
    env: { VIA_ADMIN_KEY: adminKey },
  });

  return { via, codex };
});

const viaWithUi = Effect.map(viaAndCodex, ({ via }) => via);

/**
 * Marks `first-card` in the page's performance timeline when the first overview
 * card is in the document, for every page the browser loads.
 */
const markFirstCard = `
  new MutationObserver((_, observer) => {
    if (document.querySelector("article") !== null) {
      performance.mark("first-card");
      observer.disconnect();
    }
  }).observe(document, { childList: true, subtree: true });
`;

/** The `/admin` paths the page asked for before its first card was in the document. */
const adminBeforeFirstCard = `(() => {
  const card = performance.getEntriesByName("first-card")[0].startTime;

  return performance
    .getEntriesByType("resource")
    .filter((entry) => entry.startTime < card)
    .map((entry) => new URL(entry.name).pathname)
    .filter((path) => path.startsWith("/admin"));
})()`;

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

  it.effect.runIf(withBinary)(
    "keeps the sidebar's toggle in reach on a desktop as the page scrolls",
    () =>
      Effect.gen(function* () {
        const via = yield* viaWithUi;

        // Shorter than the overview, so it scrolls.
        const { page, problems } = yield* openPage("sticky-toggle", {
          viewport: { width: 1280, height: 360 },
        });

        yield* signIn(page, via.url);

        const toggle = page.getByRole("button", { name: /^(Hide|Show) sidebar$/ });
        yield* Effect.promise(() =>
          page.evaluate("window.scrollTo(0, document.body.scrollHeight)"),
        );
        expect(yield* Effect.promise(() => page.evaluate("window.scrollY"))).toBeGreaterThan(0);

        const box = yield* Effect.promise(() => toggle.boundingBox());
        expect(box?.y).toBeGreaterThanOrEqual(0);
        expect(box?.y).toBeLessThan(48);
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

  it.effect.runIf(withBinary)(
    "paints a signed-in reload from the shell, asking /admin nothing",
    () =>
      Effect.gen(function* () {
        const via = yield* viaWithUi;
        const { page, problems } = yield* openPage("instant-reload");
        yield* Effect.promise(() => page.addInitScript(markFirstCard));
        yield* signIn(page, via.url);

        yield* Effect.promise(() => page.reload());
        yield* Effect.promise(() => page.getByRole("article", { name: "a" }).waitFor());

        expect(yield* Effect.promise(() => page.evaluate(adminBeforeFirstCard))).toEqual([]);
        expect(problems).toEqual([]);
      }),
  );

  it.effect.runIf(withBinary)("keeps the usage page's filters through a reload", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      codex.respond(() => reply.text("hi"));
      yield* post(via, "/v1/responses", { model: "gpt-5.1-codex", input: "hi" });

      const { page, problems } = yield* openPage("usage-filters");
      yield* signIn(page, via.url);
      yield* Effect.promise(() => page.goto(`${via.url}/ui/usage`));
      yield* visible(page, "Usage");

      yield* Effect.promise(() => page.getByRole("combobox", { name: "Model" }).click());
      yield* Effect.promise(() => page.keyboard.type("codex"));
      yield* Effect.promise(() => page.getByRole("option", { name: /gpt-5\.1-codex/ }).click());
      yield* Effect.promise(() => page.waitForURL(/model=gpt-5\.1-codex/));

      yield* Effect.promise(() => page.reload());

      yield* Effect.promise(() =>
        page.getByRole("combobox", { name: "Model: gpt-5.1-codex" }).waitFor({ timeout: 10_000 }),
      );

      expect(problems).toEqual([]);
    }),
  );

  it.effect.runIf(withBinary)("shows a request it served on the usage page", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      codex.respond(() => reply.text("hi"));
      const served = yield* post(via, "/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
      expect(served.status).toBe(200);

      const { page, problems } = yield* openPage("usage");
      yield* signIn(page, via.url);
      yield* Effect.promise(() => page.getByRole("link", { name: "Usage" }).click());
      yield* visible(page, "Usage");

      const requests = page.getByRole("table", { name: "Requests" });
      yield* Effect.promise(() => requests.getByText("gpt-5.1-codex").waitFor({ timeout: 10_000 }));
      yield* Effect.promise(() =>
        page.getByRole("figure", { name: "Tokens per hour" }).waitFor({ timeout: 10_000 }),
      );

      expect(problems).toEqual([]);
    }),
  );

  it.effect.runIf(withBinary)("shows a cooldown as Codex answers 429, without a reload", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      const { page, problems } = yield* openPage("live-cooldown");
      yield* signIn(page, via.url);
      const card = page.getByRole("article", { name: "a" });
      yield* Effect.promise(() => card.getByText("Available").waitFor());

      const polled: Array<string> = [];
      page.on("request", (request) => polled.push(new URL(request.url()).pathname));
      page.on("framenavigated", () => polled.push("navigation"));

      codex.respond(() =>
        reply.error(429, { error: { type: "rate_limit_exceeded" } }, { "retry-after": "120" }),
      );
      const refused = yield* post(via, "/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
      expect(refused.status).toBe(429);

      yield* Effect.promise(() => card.getByText("Cooling down").waitFor({ timeout: 5_000 }));
      expect(polled).toEqual([]);
      expect(problems).toEqual([]);
    }),
  );

  for (const [width, height] of [
    [390, 844],
    [320, 640],
  ] as const) {
    it.effect.runIf(withBinary)(`holds up on a ${width}px phone`, () =>
      Effect.gen(function* () {
        const via = yield* viaWithUi;

        const { page } = yield* openPage(`phone-${width}`, {
          viewport: { width, height },
          isMobile: true,
          hasTouch: true,
        });

        yield* signIn(page, via.url);

        // The brand and the drawer's trigger share the top bar's middle.
        const trigger = page.getByRole("button", { name: "Show sidebar" });

        const [brand, button] = yield* Effect.promise(() =>
          Promise.all([
            page.getByRole("link", { name: "via" }).boundingBox(),
            trigger.boundingBox(),
          ]),
        );

        expect(Math.abs(middle(brand) - middle(button))).toBeLessThanOrEqual(1);

        // A stat tile's count sits level with its neighbours', however its label wraps.
        expect(yield* Effect.promise(() => page.evaluate(statSpread))).toBeLessThanOrEqual(1);

        expect(yield* Effect.promise(() => page.evaluate(scrollsSideways))).toBe(false);

        // The page fills the screen rather than sitting in a frame.
        const main = yield* Effect.promise(() => page.getByRole("main").boundingBox());
        expect(main?.x).toBe(0);

        // The trigger stays in reach at the bottom of a page taller than the screen.
        yield* Effect.promise(() => page.setViewportSize({ width, height: 360 }));
        yield* Effect.promise(() =>
          page.evaluate("window.scrollTo(0, document.body.scrollHeight)"),
        );
        const scrolled = yield* Effect.promise(() => trigger.boundingBox());
        expect(scrolled?.y).toBeGreaterThanOrEqual(0);
        expect(scrolled?.y).toBeLessThan(48);

        // A field under 16px makes iOS zoom the page when it takes focus.
        yield* Effect.promise(() => page.goto(`${via.url}/ui/models`));
        const search = page.getByRole("searchbox", { name: "Search models" });
        yield* Effect.promise(() => search.waitFor());
        const size = yield* Effect.promise(() => page.evaluate(searchFontSize));
        expect(size).toBeGreaterThanOrEqual(16);

        // The usage page's charts and tables fit too, its tables scrolling on their own.
        yield* post(via, "/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
        yield* Effect.promise(() => page.goto(`${via.url}/ui/usage`));
        yield* Effect.promise(() =>
          page.getByRole("table", { name: "Requests" }).waitFor({ timeout: 10_000 }),
        );
        expect(yield* Effect.promise(() => page.evaluate(scrollsSideways))).toBe(false);
        expect(yield* Effect.promise(() => page.evaluate(radiosOnScreen))).toBe(true);

        // Every setting's choices fit across the screen, whole.
        yield* Effect.promise(() => page.goto(`${via.url}/ui/settings`));
        yield* Effect.promise(() =>
          page.getByRole("radiogroup", { name: "Time format" }).waitFor(),
        );
        expect(yield* Effect.promise(() => page.evaluate(scrollsSideways))).toBe(false);
        expect(yield* Effect.promise(() => page.evaluate(radiosOnScreen))).toBe(true);
      }),
    );
  }
});

const middle = (box: { readonly y: number; readonly height: number } | null) =>
  box === null ? Number.NaN : box.y + box.height / 2;

/** How far apart the overview's stat counts sit within a row of tiles, at most. */
const statSpread = `(() => {
  const rows = Map.groupBy(document.querySelectorAll("dl dd"), (count) =>
    Math.round(count.parentElement.getBoundingClientRect().top));
  const spreads = [...rows.values()].map((counts) => {
    const tops = counts.map((count) => count.getBoundingClientRect().top);
    return Math.max(...tops) - Math.min(...tops);
  });
  return Math.max(...spreads);
})()`;

const searchFontSize =
  'parseFloat(getComputedStyle(document.querySelector("input[type=search]")).fontSize)';

/** Whether every radio on the page sits within the screen's width. */
const radiosOnScreen = `[...document.querySelectorAll("[role=radio]")].every((radio) => {
  const box = radio.getBoundingClientRect();
  return box.left >= 0 && box.right <= window.innerWidth;
})`;

const scrollsSideways = "document.documentElement.scrollWidth > window.innerWidth";
