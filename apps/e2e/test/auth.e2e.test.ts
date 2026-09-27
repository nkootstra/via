import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { jwt } from "@via/codex-auth/testing";
import { reply } from "@via/codex-upstream/testing";
import { Effect, FileSystem, Schema } from "effect";
import {
  chat,
  errorFixture,
  json,
  launchVia,
  responsesOf,
  runVia,
  startCodex,
  startIssuer,
  tempHome,
  type Via,
} from "./harness.ts";

/** A minimal chat-completions request body; the auth checks never reach it. */
const pingRequest = {
  model: "gpt-6-astra",
  messages: [{ role: "user" as const, content: "ping" }],
  stream: false as const,
};

/** The account file `accounts add` or a refresh saved. */
const SavedAccount = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.Finite,
  }),
);

const postChatCompletions = (via: Via, headers: Record<string, string>) =>
  Effect.promise(() =>
    fetch(`${via.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(pingRequest),
    }),
  );

// The same line `formatWindow` in `apps/cli/src/accounts.ts` renders, so the usage test
// can check `via accounts status`'s own local-time formatting without editing that file.
const pad = (n: number) => String(n).padStart(2, "0");

const formatWindow = (windowMinutes: number, usedPercent: number, resetsAtMs: number) => {
  const length = windowMinutes % 1440 === 0 ? `${windowMinutes / 1440}d` : `${windowMinutes / 60}h`;
  const at = new Date(resetsAtMs);
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;

  return `  ${length.padEnd(4)} ${String(usedPercent).padStart(3)}% used  resets ${date} ${time}`;
};

layer(BunFileSystem.layer)("via auth and tokens", (it) => {
  it.effect("rejects missing, non-Bearer, and wrong API keys without ever calling upstream", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: upstream.url });
      const noHeader = yield* postChatCompletions(via, {});
      expect(noHeader.status).toBe(401);
      expect(yield* json(noHeader)).toMatchObject({ error: { code: "invalid_api_key" } });

      const nonBearer = yield* postChatCompletions(via, { authorization: "Basic dGVzdA==" });
      expect(nonBearer.status).toBe(401);
      expect(yield* json(nonBearer)).toMatchObject({ error: { code: "invalid_api_key" } });

      const wrongKey = yield* postChatCompletions(via, {
        authorization: "Bearer via_not-a-real-key",
      });

      expect(wrongKey.status).toBe(401);
      expect(yield* json(wrongKey)).toMatchObject({ error: { code: "invalid_api_key" } });

      expect(responsesOf(upstream)).toHaveLength(0);
    }),
  );

  it.effect("rejects a key once it is revoked, while via serve keeps running", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: upstream.url });
      const before = yield* chat(via, "ping");

      expect(before.choices[0]?.message.content).toBe("pong");

      const revoked = yield* runVia(via.home, ["keys", "revoke", "e2e"], via.env);
      expect(revoked.exitCode).toBe(0);

      const after = yield* postChatCompletions(via, { authorization: `Bearer ${via.key}` });
      expect(after.status).toBe(401);
      expect(yield* json(after)).toMatchObject({ error: { code: "invalid_api_key" } });

      // Only the one request that succeeded before revocation ever reached upstream.
      expect(responsesOf(upstream)).toHaveLength(1);
    }),
  );

  it.effect("keeps a key working after a second key is created", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.respond(() => reply.text("pong"));
      const via = yield* launchVia({ upstream: upstream.url });
      const created = yield* runVia(via.home, ["keys", "create", "--name", "second"], via.env);
      expect(created.exitCode).toBe(0);

      const completion = yield* chat(via, "ping");

      expect(completion.choices[0]?.message.content).toBe("pong");
      expect(responsesOf(upstream)).toHaveLength(1);
    }),
  );

  it.effect(
    "refreshes an access token expiring soon before calling upstream, and persists it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const upstream = yield* startCodex;
        upstream.respond(() => reply.text("pong"));

        const NEW_EXP = 2_100_000_000; // seconds; far beyond the test's lifetime
        const refreshedAccessToken = jwt({ exp: NEW_EXP });

        const refreshedIdToken = jwt({
          email: "a@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acc-a", chatgpt_plan_type: "pro" },
        });

        const via = yield* launchVia({
          upstream: upstream.url,
          accounts: [{ name: "a", expiresAt: Date.now() + 2 * 60 * 1000 }],
          issuer: {
            refreshResponse: {
              status: 200,
              body: {
                access_token: refreshedAccessToken,
                id_token: refreshedIdToken,
                refresh_token: "rt-2",
              },
            },
          },
        });

        const completion = yield* chat(via, "ping");

        expect(completion.choices[0]?.message.content).toBe("pong");

        // One upstream call, and it already carries the refreshed token: the
        // refresh happened before dispatch, not as a retry after a 401.
        expect(responsesOf(upstream)).toHaveLength(1);
        expect(upstream.requests[0]?.headers).toMatchObject({
          authorization: `Bearer ${refreshedAccessToken}`,
          "chatgpt-account-id": "acc-a",
        });

        const saved = yield* fs
          .readFileString(`${via.home}/auth/a.json`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SavedAccount)));

        expect(saved.accessToken).toBe(refreshedAccessToken);
        expect(saved.refreshToken).toBe("rt-2");
        expect(saved.expiresAt).toBe(NEW_EXP * 1000);
      }),
  );

  it.effect("retries once after codex's own 401, refreshing the same account", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      // The default fake-issuer identity (dev@example.com / acc-123) matches the one
      // account a device-code login creates, so the refresh it grants saves back onto it.
      upstream.script(yield* errorFixture("unauthorized_401"), reply.text("pong"));

      const via = yield* launchVia({ upstream: upstream.url });

      const completion = yield* chat(via, "ping");

      expect(completion.choices[0]?.message.content).toBe("pong");

      expect(responsesOf(upstream)).toHaveLength(2);
      const first = upstream.requests[0]?.headers.authorization;
      const second = upstream.requests[1]?.headers.authorization;
      expect(first).toMatch(/^Bearer \S+/);
      expect(second).toMatch(/^Bearer \S+/);
      // The retry used a different (refreshed) access token, not the one that was
      // just refused.
      expect(second).not.toBe(first);
      expect(upstream.requests[1]?.headers["chatgpt-account-id"]).toBe("acc-123");
    }),
  );

  it.effect("locks out an account whose refresh is rejected and serves the next account", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;
      upstream.respond(() => reply.text("pong"));

      const via = yield* launchVia({
        upstream: upstream.url,
        accounts: [{ name: "a", expiresAt: Date.now() + 2 * 60 * 1000 }, { name: "b" }],
        issuer: {
          refreshResponse: {
            status: 400,
            body: { error: "invalid_grant", error_description: "refresh token expired" },
          },
        },
      });

      const completion = yield* chat(via, "ping");

      expect(completion.choices[0]?.message.content).toBe("pong");

      // "a"'s rejected refresh never reaches upstream; only "b"'s request does.
      expect(responsesOf(upstream)).toHaveLength(1);
      expect(upstream.requests[0]?.headers).toMatchObject({
        authorization: "Bearer at-b",
        "chatgpt-account-id": "acc-b",
      });

      const status = yield* runVia(via.home, ["accounts", "status"], via.env);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toMatch(
        /The refresh token was rejected \(.*\); log in to this account again/,
      );

      const list = yield* runVia(via.home, ["accounts", "list"], via.env);
      expect(list.stdout).toContain("a@example.com");
      expect(list.stdout).toContain("b@example.com");
    }),
  );

  it.effect("reports usage windows fetched from the upstream's usage endpoint", () =>
    Effect.gen(function* () {
      const upstream = yield* startCodex;

      const usagePayload = {
        rate_limit: {
          primary_window: {
            used_percent: 12,
            limit_window_seconds: 18_000,
            reset_at: 2_100_000_000,
          },
          secondary_window: {
            used_percent: 34,
            limit_window_seconds: 604_800,
            reset_at: 2_200_000_000,
          },
        },
      };

      upstream.usage("acc-123", usagePayload);

      const via = yield* launchVia({ upstream: upstream.url });
      const status = yield* runVia(via.home, ["accounts", "status"], via.env);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain("dev@example.com");
      expect(status.stdout).toContain(formatWindow(300, 12, 2_100_000_000 * 1000));
      expect(status.stdout).toContain(formatWindow(10_080, 34, 2_200_000_000 * 1000));
      expect(upstream.requests.at(-1)).toMatchObject({
        path: "/wham/usage",
        headers: { "chatgpt-account-id": "acc-123" },
      });
    }),
  );

  it.effect("logs in via the device code flow and lists the new account", () =>
    Effect.gen(function* () {
      const home = yield* tempHome;
      const issuer = yield* startIssuer();
      const env = { VIA_CODEX_ISSUER: issuer };

      const added = yield* runVia(home, ["accounts", "add"], env);
      expect(added.exitCode).toBe(0);
      expect(added.stdout).toContain("dev@example.com");

      const listed = yield* runVia(home, ["accounts", "list"], env);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain("dev@example.com");
    }),
  );
});
