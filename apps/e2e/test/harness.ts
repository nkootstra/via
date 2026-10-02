import { createKey, type SeededAccount, seedAccounts, serveVia, viaHome } from "@via/cli/testing";
import type { FakeIssuerOptions } from "@via/codex-auth/testing";
import {
  type CodexRequest,
  codexErrorFixture,
  type FakeCodex,
  reply,
  startFakeCodex,
} from "@via/codex-upstream/testing";
import { Effect, Exit, Predicate, Schema } from "effect";
import OpenAI from "openai";
import { type BrowserContextOptions, chromium, type Page } from "playwright";

export { freePort, realTime, runVia, tempHome } from "@via/cli/testing";

/** The fake Codex backend, scoped; point via at `codex.url`. */
export const startCodex = startFakeCodex;

export type Codex = FakeCodex;

export type Via = {
  home: string;
  url: string;
  key: string;
  env: Record<string, string>;
};

/**
 * Starts a `via serve` with one API key, for as long as the test's scope,
 * sending upstream traffic to `upstream`. Its pool is one account logged in
 * through the fake issuer (`dev@example.com`, `acc-123`), or `accounts` when given.
 */
export const launchVia = (options: {
  upstream: string;
  /** Seed these accounts instead of logging one in through the fake issuer. */
  accounts?: ReadonlyArray<SeededAccount>;
  issuer?: FakeIssuerOptions;
  /** More environment for every `via` command, `via serve` included. */
  env?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { home, env, via } = yield* viaHome(options);

    if (options.accounts === undefined) yield* via("accounts", "add");
    else yield* seedAccounts(home, options.accounts);
    const key = yield* createKey(home, "e2e");
    // Port 0 lets the OS pick a free port; via reports the one it got.
    const url = yield* serveVia(home, ["--port", "0"], env);

    return { home, url, key, env } satisfies Via;
  });

/** The official SDK, pointed at via. */
export const openai = (via: Via) =>
  new OpenAI({ baseURL: `${via.url}/v1`, apiKey: via.key, maxRetries: 0 });

/** A chat completion for `content` through the SDK. */
export const chat = (via: Via, content: string) =>
  Effect.promise(() =>
    openai(via).chat.completions.create({
      model: "gpt-6-astra",
      messages: [{ role: "user", content }],
    }),
  );

/**
 * POSTs `body` to via with its API key, for what the SDK hides or can't send:
 * an object goes as JSON, a string as it is.
 */
export const post = (
  via: Via,
  path: string,
  body: Schema.JsonObject | string,
  signal?: AbortSignal,
) =>
  Effect.promise(() =>
    fetch(`${via.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${via.key}` },
      body: Predicate.isString(body) ? body : JSON.stringify(body),
      ...(signal !== undefined && { signal }),
    }),
  );

/** Decodes one JSON text, such as an SSE `data` line, with `schema`. */
export const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(schema));

/** A response's JSON body. */
export const json = (response: Response) => Effect.promise(() => response.json());

/** The Responses requests Codex received, in order, leaving out usage lookups. */
export const responsesOf = (codex: Codex): ReadonlyArray<CodexRequest> =>
  codex.requests.filter((request) => request.path === "/codex/responses");

/**
 * A Chromium page, for as long as the test's scope, and `problems`: every page
 * error and console error it logs, a CSP violation among them. A 401 is left
 * out: the app asks for its session to learn whether it's signed in, and
 * Chromium logs the answer when it's no. The page records a trace, kept as
 * `test-results/<name>.zip` when the test fails.
 */
export const openPage = (name: string, options: BrowserContextOptions = {}) =>
  Effect.gen(function* () {
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch()),
      (opened) => Effect.promise(() => opened.close()),
    );

    const context = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const opened = await browser.newContext(options);
        await opened.tracing.start({ screenshots: true, snapshots: true });

        return opened;
      }),
      (opened, exit) =>
        Effect.promise(() =>
          opened.tracing.stop(
            Exit.isFailure(exit)
              ? { path: `${import.meta.dirname}/../test-results/${name}.zip` }
              : {},
          ),
        ),
    );

    const page = yield* Effect.promise(() => context.newPage());
    const problems: Array<string> = [];
    page.on("pageerror", (error) => problems.push(error.message));

    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !/^Failed to load resource: .* 401\b/.test(message.text())
      ) {
        problems.push(message.text());
      }
    });

    return { page, problems };
  });

/** One of codex's recorded error answers, verbatim, as a reply. */
export const errorFixture = (name: string) =>
  Effect.map(codexErrorFixture(name), ({ status, headers, body }) =>
    reply.error(status, body, headers),
  );

/** The admin key a via that serves the UI is started with. */
export const adminKey = "admin-key-that-is-long-enough-000";

/**
 * Whether the browser tests run: they drive the UI embedded in a compiled
 * binary, as users get it, and the build job, which has one, installs Chromium.
 */
export const withBinary = process.env["VIA_E2E_BIN"] !== undefined;

/** Waits for the heading `name`, as a page or dialog comes in. */
export const visible = (page: Page, name: string) =>
  Effect.promise(() => page.getByRole("heading", { name }).waitFor({ timeout: 10_000 }));

/** Signs in to the UI at `url` with the admin key, landing on the overview. */
export const signIn = (page: Page, url: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.goto(`${url}/ui/`));
    yield* visible(page, "Sign in");
    yield* Effect.promise(() => page.getByLabel("Admin key").fill(adminKey));
    yield* Effect.promise(() => page.getByRole("button", { name: "Sign in" }).click());
    yield* visible(page, "Overview");
  });
