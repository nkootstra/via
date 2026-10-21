import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import {
  adminKey,
  decodeJson,
  json,
  launchVia,
  realTime,
  startCodex,
  type Via,
} from "./harness.ts";

// Keeping the prompts of failed turns, end to end: the switch, what a failed turn leaves in
// `bodies.db` and what the admin API answers of it, that no secret it held reaches a file in
// via's home, and that deleting the prompts or the history leaves no copy of them behind.
// That a prompt is gone after its 7 days takes a clock the binary can't be moved on: the
// usage package's tests cover it.

/** Secrets a coding agent's turn can carry, all fake: none may reach a file in via's home. */
const secrets = {
  openai: "sk-proj-e2eFAKEk3yAbCdEfGhIjKlMnOpQrStUv0123456789",
  github: "ghp_e2eFAKE0123456789AbCdEfGhIjKlMnOpQrSt",
  basic: "dXNlcjpwYXNzd29yZA==",
  accessToken: "ya29.a0e2eFAKEAfH6SMBx3kq9ZpLw7RtYv2",
  apiKeys: ["e2eFAKEapikey0Q9w8E7r6T5y", "e2eFAKEapikey1Z2x3C4v5B6n"],
  cookie: "session=e2eFAKEs3ss10nV4lu3AbCdEf0123",
  privateKey: "MIIEe2eFAKEpAIBAAKCAQEAx7Lq0Zr4bW9vNnT3kJ5sQ1",
} as const;

/** A PNG's bytes, made up, sent inline as base64. */
const png = Buffer.from(
  Array.from({ length: 3 * 1024 }, (_, index) => (index * 7919) % 251),
).toString("base64");

/** Every fake secret, and the image, as written: what must reach no file. */
const forbidden = [
  secrets.openai,
  secrets.github,
  secrets.basic,
  secrets.accessToken,
  ...secrets.apiKeys,
  secrets.cookie,
  secrets.privateKey,
  png.slice(0, 64),
];

/** A `.env` file as a tool read it, with `openai` and `github` for its keys. */
const envFile = (openai: string, github: string) =>
  `NODE_ENV=development\nOPENAI_API_KEY=${openai}\nGITHUB_TOKEN=${github}\n`;

/** A request a tool logged, as JSON, and the cookie line after it. */
const requestLog = (values: {
  basic: string;
  accessToken: string;
  apiKeys: ReadonlyArray<string>;
  cookie: string;
}) =>
  `${JSON.stringify(
    {
      url: "https://api.example.com/v2/items",
      headers: { Authorization: `Basic ${values.basic}` },
      accessToken: values.accessToken,
      api_keys: values.apiKeys,
    },
    null,
    2,
  )}\nCookie: ${values.cookie}`;

/** JSON via answered or wrote, as a value to compare. */
const parseJson = decodeJson(Schema.Json);

/** A chat turn of a coding agent, its tool results holding these values, asking `question`. */
const turn = (
  question: string,
  values: {
    openai: string;
    github: string;
    basic: string;
    accessToken: string;
    apiKeys: ReadonlyArray<string>;
    cookie: string;
    image: string;
  },
) => ({
  model: "gpt-6-astra",
  messages: [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Why does the request fail?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_env",
          type: "function",
          function: { name: "read", arguments: '{"path":".env"}' },
        },
        {
          id: "call_log",
          type: "function",
          function: { name: "read", arguments: '{"path":"req.log"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_env", content: envFile(values.openai, values.github) },
    { role: "tool", tool_call_id: "call_log", content: requestLog(values) },
    {
      role: "user",
      content: [
        { type: "text", text: question },
        { type: "image_url", image_url: { url: values.image } },
      ],
    },
  ],
});

/** A turn holding every fake secret. */
const secretTurn = (question: string) =>
  turn(question, { ...secrets, image: `data:image/png;base64,${png}` });

/** That turn as via keeps it: every secret a marker, the image a note. */
const redactedTurn = (question: string) =>
  turn(question, {
    openai: "[redacted:openai-key]",
    github: "[redacted:github-token]",
    basic: "[redacted:authorization]",
    accessToken: "[redacted:secret]",
    apiKeys: ["[redacted:secret]", "[redacted:secret]"],
    cookie: "[redacted:cookie]",
    image: "[image: png, 3 KB]",
  });

/** Codex down, its error quoting a private key cut off before its END line. */
const overloaded = reply.error(503, {
  error: {
    type: "server_error",
    code: "server_is_overloaded",
    message: `Could not load the signing key: -----BEGIN RSA PRIVATE KEY-----\n${secrets.privateKey}\nAbCd`,
  },
});

/** Codex rate limiting the account, quoting the client's key back. */
const rateLimited = reply.error(
  429,
  { error: { type: "rate_limit_exceeded", message: `Rate limit reached for ${secrets.openai}` } },
  { "retry-after": "120" },
);

/** A via with one account and the admin API, and its fake Codex. */
const viaAndCodex = Effect.gen(function* () {
  const codex = yield* startCodex;

  const via = yield* launchVia({
    upstream: codex.url,
    accounts: [{ name: "a" }],
    env: { VIA_ADMIN_KEY: adminKey },
  });

  return { via, codex };
});

/** Signs in to the admin API: the session cookie. */
const signIn = (via: Via) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${via.url}/admin/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: adminKey }),
      }),
    );

    expect(response.status).toBe(204);

    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

/** Calls the admin API as a signed-in page does: the cookie, and for a change the CSRF header. */
const admin = (via: Via, cookie: string, path: string, method = "GET", body?: Schema.JsonObject) =>
  Effect.promise(() =>
    fetch(`${via.url}/admin${path}`, {
      method,
      headers: {
        cookie,
        ...(method !== "GET" && { "x-via-csrf": "1", origin: new URL(via.url).origin }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );

/** Turns keeping failed turns' prompts on. */
const keepFailedPrompts = (via: Via, cookie: string) =>
  Effect.gen(function* () {
    const response = yield* admin(via, cookie, "/history/capture", "PUT", {
      keepFailedPrompts: true,
    });

    expect(response.status).toBe(200);
  });

/** Sends a chat turn in conversation `session`, with `headers` besides. */
const send = (
  via: Via,
  session: string,
  body: Schema.JsonObject,
  headers: Record<string, string> = {},
) =>
  Effect.promise(async () => {
    const response = await fetch(`${via.url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${via.key}`,
        "x-opencode-session-id": session,
        ...headers,
      },
      body: JSON.stringify(body),
    });

    await response.text();

    return response;
  });

const Conversation = Schema.Struct({
  turns: Schema.Array(Schema.Struct({ requestId: Schema.String, status: Schema.Finite })),
  attempts: Schema.Array(Schema.Struct({ requestId: Schema.String, seq: Schema.Finite })),
  captured: Schema.Array(Schema.String),
});

/**
 * Conversation `id` once via has kept `turns` turns of it. A turn is captured before it is
 * kept, so by then its capture is there too.
 */
const conversation = (via: Via, cookie: string, id: string, turns: number) =>
  admin(via, cookie, `/history/conversations/${id}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.flatMap(json(response), Schema.decodeUnknownEffect(Conversation))
        : Effect.succeed(Conversation.make({ turns: [], attempts: [], captured: [] })),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("50 millis"),
      until: (found) => found.turns.length >= turns,
    }),
    Effect.timeout("10 seconds"),
    realTime,
    // Test boundary: a conversation that never shows up, or doesn't decode, fails the test.
    Effect.orDie,
  );

/** Request `id`'s captured body: its status and its text. */
const body = (via: Via, cookie: string, id: string) =>
  Effect.flatMap(admin(via, cookie, `/history/requests/${id}/body`), (response) =>
    Effect.map(
      Effect.promise(() => response.text()),
      (text) => ({ status: response.status, text }),
    ),
  );

/** Every file in via's home, as text, by its path in it. */
const filesOf = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* fs.readDirectory(home, { recursive: true });

    const files = yield* Effect.forEach(paths, (path) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(`${home}/${path}`);

        if (info.type !== "File") return [];

        return [[path, new TextDecoder().decode(yield* fs.readFile(`${home}/${path}`))] as const];
      }),
    );

    return files.flat();
  }).pipe(
    // Test boundary: a home that can't be read fails the test.
    Effect.orDie,
  );

/** The files in via's home that hold any of `texts`, with the first each holds. */
const holding = (home: string, texts: ReadonlyArray<string>) =>
  Effect.map(filesOf(home), (files) =>
    files.flatMap(([path, content]) => {
      const found = texts.find((text) => content.includes(text));

      return found === undefined ? [] : [`${path}: ${found}`];
    }),
  );

layer(BunFileSystem.layer)("captured prompts", (it) => {
  it.effect("turns keeping failed turns' prompts on, in capture.json", () =>
    Effect.gen(function* () {
      const { via } = yield* viaAndCodex;
      const cookie = yield* signIn(via);
      const fs = yield* FileSystem.FileSystem;

      expect(yield* json(yield* admin(via, cookie, "/history/capture"))).toEqual({
        keepFailedPrompts: false,
      });

      yield* keepFailedPrompts(via, cookie);

      expect(yield* json(yield* admin(via, cookie, "/history/capture"))).toEqual({
        keepFailedPrompts: true,
      });

      const file = yield* fs.readFileString(`${via.home}/capture.json`);
      expect(parseJson(file)).toEqual({ keepFailedPrompts: true });
    }),
  );

  it.effect("keeps a failed turn's prompt redacted, and no secret of it in any file", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      const cookie = yield* signIn(via);
      yield* keepFailedPrompts(via, cookie);

      codex.script(overloaded, rateLimited);
      const down = yield* send(via, "ses_secrets", secretTurn("Is Codex down?"));
      const limited = yield* send(via, "ses_secrets", secretTurn("Am I rate limited?"));

      expect(down.status).toBe(503);
      expect(limited.status).toBe(429);

      const found = yield* conversation(via, cookie, "ses_secrets", 2);
      const [first, second] = found.turns.map((entry) => entry.requestId);
      expect(found.captured).toEqual([first, second]);

      const kept = yield* body(via, cookie, first ?? "");
      expect(kept.status).toBe(200);

      expect(parseJson(kept.text)).toEqual({
        requestId: first,
        capturedAt: expect.any(Number),
        endpoint: "chat/completions",
        request: redactedTurn("Is Codex down?"),
        upstreamErrors: [
          {
            seq: 0,
            status: 503,
            body: {
              error: {
                type: "server_error",
                code: "server_is_overloaded",
                message: "Could not load the signing key: [redacted:private-key]",
              },
            },
          },
        ],
        redactions: [
          { kind: "authorization", count: 1 },
          { kind: "cookie", count: 1 },
          { kind: "github-token", count: 1 },
          { kind: "image", count: 1 },
          { kind: "openai-key", count: 1 },
          { kind: "private-key", count: 1 },
          { kind: "secret", count: 3 },
        ],
        truncated: false,
        sizeBytes: expect.any(Number),
      });

      const keptLimited = yield* body(via, cookie, second ?? "");

      expect(parseJson(keptLimited.text)).toMatchObject({
        request: redactedTurn("Am I rate limited?"),
        upstreamErrors: [
          {
            seq: 0,
            status: 429,
            body: {
              error: {
                type: "rate_limit_exceeded",
                message: "Rate limit reached for [redacted:openai-key]",
              },
            },
          },
        ],
      });

      const conversationText = yield* Effect.flatMap(
        admin(via, cookie, "/history/conversations/ses_secrets"),
        (response) => Effect.promise(() => response.text()),
      );

      for (const text of [kept.text, keptLimited.text, conversationText]) {
        expect(forbidden.filter((secret) => text.includes(secret))).toEqual([]);
      }

      expect(yield* holding(via.home, forbidden)).toEqual([]);
    }),
  );

  it.effect("keeps nothing of a turn that went well", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      const cookie = yield* signIn(via);
      yield* keepFailedPrompts(via, cookie);

      codex.script(reply.text("It works now."));
      const answered = yield* send(via, "ses_fine", secretTurn("Does it work?"));
      expect(answered.status).toBe(200);

      const found = yield* conversation(via, cookie, "ses_fine", 1);
      expect(found.captured).toEqual([]);
      expect((yield* body(via, cookie, found.turns[0]?.requestId ?? "")).status).toBe(404);
      expect(yield* holding(via.home, ["Does it work?", ...forbidden])).toEqual([]);
    }),
  );

  it.effect("keeps nothing of a failed turn while the setting is off", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      const cookie = yield* signIn(via);

      codex.script(overloaded);
      expect((yield* send(via, "ses_off", secretTurn("Is it off?"))).status).toBe(503);

      const found = yield* conversation(via, cookie, "ses_off", 1);
      expect(found.captured).toEqual([]);
      expect((yield* body(via, cookie, found.turns[0]?.requestId ?? "")).status).toBe(404);
      expect(yield* holding(via.home, ["Is it off?", ...forbidden])).toEqual([]);
    }),
  );

  it.effect("names two turns sending the same x-request-id apart, and keeps them apart", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      const cookie = yield* signIn(via);
      yield* keepFailedPrompts(via, cookie);

      const clientId = "550e8400-e29b-41d4-a716-446655440000";
      codex.script(overloaded, rateLimited);

      const answers = yield* Effect.forEach(["first question", "second question"], (question) =>
        send(via, "ses_same_id", secretTurn(question), { "x-request-id": clientId }),
      );

      // via answers the client by the id it sent, so it can match its answers.
      expect(answers.map((answer) => answer.headers.get("x-request-id"))).toEqual([
        clientId,
        clientId,
      ]);

      const found = yield* conversation(via, cookie, "ses_same_id", 2);
      const ids = found.turns.map((entry) => entry.requestId);
      expect(new Set(ids).size).toBe(2);
      expect(ids).not.toContain(clientId);
      expect(found.captured).toEqual(ids);

      expect(found.attempts.map((attempt) => [attempt.requestId, attempt.seq])).toEqual([
        [ids[0], 0],
        [ids[1], 0],
      ]);

      const kept = yield* Effect.forEach(ids, (id) =>
        Effect.map(body(via, cookie, id), ({ text }) => parseJson(text)),
      );

      expect(kept).toMatchObject([
        {
          requestId: ids[0],
          request: redactedTurn("first question"),
          upstreamErrors: [{ seq: 0, status: 503 }],
        },
        {
          requestId: ids[1],
          request: redactedTurn("second question"),
          upstreamErrors: [{ seq: 0, status: 429 }],
        },
      ]);
    }),
  );

  it.effect("deletes every captured prompt, and leaves no copy of one in any file", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      const cookie = yield* signIn(via);
      yield* keepFailedPrompts(via, cookie);

      const question = "Where did canary-e2e-7f3a1c go?";
      codex.script(overloaded);
      yield* send(via, "ses_delete", secretTurn(question));
      const found = yield* conversation(via, cookie, "ses_delete", 1);
      const id = found.turns[0]?.requestId ?? "";
      expect((yield* body(via, cookie, id)).status).toBe(200);
      expect(yield* holding(via.home, [question])).not.toEqual([]);

      const deleted = yield* admin(via, cookie, "/history/bodies", "DELETE");
      expect(yield* json(deleted)).toEqual({ deleted: 1 });

      expect((yield* body(via, cookie, id)).status).toBe(404);
      expect((yield* conversation(via, cookie, "ses_delete", 1)).captured).toEqual([]);
      expect(yield* holding(via.home, [question])).toEqual([]);
    }),
  );

  it.effect("deletes the captured prompts with the history", () =>
    Effect.gen(function* () {
      const { via, codex } = yield* viaAndCodex;
      const cookie = yield* signIn(via);
      yield* keepFailedPrompts(via, cookie);

      const question = "Where did canary-e2e-9b2d4e go?";
      codex.script(overloaded);
      yield* send(via, "ses_history", secretTurn(question));
      const id = (yield* conversation(via, cookie, "ses_history", 1)).turns[0]?.requestId ?? "";
      expect((yield* body(via, cookie, id)).status).toBe(200);

      const deleted = yield* admin(via, cookie, "/history", "DELETE");
      expect(yield* json(deleted)).toEqual({ deleted: 1 });

      expect((yield* body(via, cookie, id)).status).toBe(404);

      expect((yield* admin(via, cookie, "/history/conversations/ses_history")).status).toBe(404);

      expect(yield* holding(via.home, [question])).toEqual([]);
    }),
  );
});
